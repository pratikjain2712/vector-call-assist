'use strict';
/* Tests for web/js/admin/add-row.js ("+ Add one" beside every Excel import): the student form check, phones
   normalised like the lead importer, the duplicate check before a student is saved, the lead row of "+ Add lead"
   and the hand table of New calling list, the extra fields of a list, and the Excel templates (their headings are
   the ones the importers guess, read back through the real SheetJS). Plus static checks: the module is loaded
   before the tabs that use them, builds no HTML strings, and both tabs use it.
   Run: node --test tests/web/add-row.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const AR = require(path.join(root, 'web', 'js', 'admin', 'add-row.js'));
const F = require(path.join(root, 'web', 'js', 'admin', 'fees.js'));
const LU = require(path.join(root, 'web', 'js', 'lead-upload.js'));
const XL = require(path.join(root, 'web', 'js', 'excel-export.js'));

const TODAY = '2026-10-26';
const good = () => ({ name: 'Kabir Jain', admission_no: 'A201', class_label: '8', section: 'B', board: 'cbse', academic_year: '2026-2027',
  parent_name: 'Rakesh Jain', phone: '098765 00011', alt_phone: '',
  fees: [{ head: 'Term 2 tuition', amount: '18,000', due_date: '2026-11-10' }, { head: '', amount: '', due_date: '' }],
  paid: { amount: '6000', paid_on: '2026-10-20', mode: 'upi', reference: 'UTR4455' } });

// ----- phones -----
test('phones are normalised like the lead importer and the database', () => {
  assert.deepStrictEqual(AR.phone('098765 43210'), { status: 'ok', value: '+919876543210' });
  assert.deepStrictEqual(AR.phone('+91 98765-43210'), { status: 'ok', value: '+919876543210' });
  assert.deepStrictEqual(AR.phone('919876543210'), { status: 'ok', value: '+919876543210' });
  assert.deepStrictEqual(AR.phone('98765'), { status: 'bad', value: '' });
  assert.deepStrictEqual(AR.phone('  '), { status: 'missing', value: '' });
  assert.deepStrictEqual(AR.phone(null), { status: 'missing', value: '' });
});

// ----- the student form -----
test('a good student form has no problem', () => {
  assert.strictEqual(AR.studentProblem(good(), { today: TODAY, withMoney: true }), null);
});
test('required fields and bad values are named, with their field', () => {
  const p = (change, opts) => AR.studentProblem(Object.assign(good(), change), Object.assign({ today: TODAY, withMoney: true }, opts || {}));
  assert.deepStrictEqual(p({ name: '  ' }), { field: 'name', text: 'Write the student\'s name.' });
  assert.strictEqual(p({ phone: '' }).field, 'phone');
  assert.strictEqual(p({ phone: '' }, { phoneRequired: false }), null);
  assert.match(p({ phone: '12345' }).text, /10-digit/);
  assert.strictEqual(p({ alt_phone: '987' }).field, 'alt_phone');
  assert.strictEqual(p({ alt_phone: '+919876500011' }).field, 'alt_phone');   // the same as the phone
  assert.strictEqual(p({ board: 'XYZ' }).field, 'board');
  assert.strictEqual(p({ board: 'State board' }), null);
  assert.strictEqual(p({ academic_year: '26-27' }).field, 'academic_year');
  assert.strictEqual(p({ admission_no: 'x'.repeat(41) }).field, 'admission_no');
});
test('fees: an empty line is left out, a started line needs name, amount and due date', () => {
  const p = (fees) => AR.studentProblem(Object.assign(good(), { fees }), { today: TODAY, withMoney: true });
  assert.strictEqual(p([{ head: '', amount: '', due_date: '' }]), null);
  assert.deepStrictEqual(p([{ head: '', amount: '500', due_date: '' }]).field, 'fee-0-head');
  assert.deepStrictEqual(p([{ head: 'Bus', amount: 'abc', due_date: '2026-11-01' }]).field, 'fee-0-amount');
  assert.deepStrictEqual(p([{ head: 'Bus', amount: '0', due_date: '2026-11-01' }]).field, 'fee-0-amount');
  assert.deepStrictEqual(p([{ head: 'Bus', amount: '500', due_date: '' }]).field, 'fee-0-due_date');
  assert.deepStrictEqual(p([{ head: 'Bus', amount: '500', due_date: '2026-02-30' }]).field, 'fee-0-due_date');
  assert.strictEqual(AR.studentProblem(Object.assign(good(), { fees: [{ head: 'Bus' }] }), { today: TODAY }), null);   // edit: no money checks
});
test('paid so far: amount, a date not in the future, a mode, a reference for UPI, bank and card, never a UPI ID', () => {
  const p = (paid) => AR.studentProblem(Object.assign(good(), { paid }), { today: TODAY, withMoney: true });
  assert.strictEqual(p({ amount: '' }), null);
  assert.strictEqual(p({ amount: '-5', paid_on: TODAY, mode: 'cash' }).field, 'paid-amount');
  assert.strictEqual(p({ amount: '500', paid_on: '2026-10-27', mode: 'cash' }).field, 'paid-paid_on');
  assert.strictEqual(p({ amount: '500', paid_on: TODAY, mode: 'gold' }).field, 'paid-mode');
  assert.strictEqual(p({ amount: '500', paid_on: TODAY, mode: 'upi', reference: '' }).field, 'paid-reference');
  assert.match(p({ amount: '500', paid_on: TODAY, mode: 'upi', reference: 'meena@okbank' }).text, /not a UPI ID/);
  assert.strictEqual(p({ amount: '500', paid_on: TODAY, mode: 'cash', reference: '' }), null);
});
test('what is sent: every detail key (an edit can clear one), the fees and the payment', () => {
  assert.deepStrictEqual(AR.studentData(good()), { name: 'Kabir Jain', admission_no: 'A201', class_label: '8', section: 'B', board: 'CBSE',
    academic_year: '2026-27', parent_name: 'Rakesh Jain', phone: '+919876500011', alt_phone: '' });
  assert.deepStrictEqual(AR.studentFees(good()), [{ p_head: 'Term 2 tuition', p_amount: 18000, p_due_date: '2026-11-10', p_academic_year: '2026-27' }]);
  assert.deepStrictEqual(AR.studentPayment(good()), { p_amount: 6000, p_paid_on: '2026-10-20', p_mode: 'upi', p_reference: 'UTR4455',
    p_note: 'Paid so far, added with the student' });
  assert.strictEqual(AR.studentPayment(Object.assign(good(), { paid: { amount: '' } })), null);
});

// ----- duplicates -----
const LIST = [
  { student_id: 's1', name: 'Aarav Shah', admission_no: 'A101', class_label: '8', section: 'A', phone: '+919876500001', alt_phone: null },
  { student_id: 's2', name: 'Diya Rao', admission_no: 'A102', class_label: '9', phone: '+919876500002', alt_phone: '+919876500009' },
  { student_id: 's3', name: 'Riya Shah', admission_no: null, class_label: '6', phone: '+919876500001', alt_phone: null },
];
test('duplicates: the same admission number in any case', () => {
  const d = AR.findDuplicates({ name: 'Someone', admission_no: 'a101', phone: '' }, LIST, null);
  assert.deepStrictEqual(d.map((x) => [x.student_id, x.reason]), [['s1', 'admission']]);
  assert.match(d[0].text, /Admission number A101 is already Aarav Shah's/);
});
test('duplicates: the same name and phone (or alternate phone); a sibling on the same phone is not one', () => {
  assert.deepStrictEqual(AR.findDuplicates({ name: '  aarav   SHAH ', phone: '98765 00001' }, LIST, null).map((x) => [x.student_id, x.reason]), [['s1', 'phone_name']]);
  assert.deepStrictEqual(AR.findDuplicates({ name: 'Diya Rao', phone: '9876500009' }, LIST, null).map((x) => x.student_id), ['s2']);
  assert.deepStrictEqual(AR.findDuplicates({ name: 'Diya Rao', phone: '9000000000', alt_phone: '9876500002' }, LIST, null).map((x) => x.student_id), ['s2']);
  assert.deepStrictEqual(AR.findDuplicates({ name: 'Kiran Shah', phone: '9876500001' }, LIST, null), []);
  assert.deepStrictEqual(AR.findDuplicates({ name: 'Aarav Shah', phone: '9000000000' }, LIST, null), []);
});
test('duplicates: the student being edited is not its own duplicate; admission first', () => {
  assert.deepStrictEqual(AR.findDuplicates({ name: 'Aarav Shah', admission_no: 'A101', phone: '9876500001' }, LIST, 's1'), []);
  const both = AR.findDuplicates({ name: 'Riya Shah', admission_no: 'A102', phone: '9876500001' }, LIST, null);
  assert.deepStrictEqual(both.map((x) => x.reason), ['admission', 'phone_name']);
  assert.deepStrictEqual(AR.findDuplicates({ name: 'X' }, null, null), []);
});

// ----- + Add lead -----
test('a lead row: name and phone needed, extra fields kept, the source, consent only when it differs from the default', () => {
  const r = AR.leadRow({ name: ' Meena Shah ', phone: '098765 43210', extra: { Student: 'Aarav', Class: ' 8 ', Empty: ' ' }, amount: '7,000',
    source: 'a call to our office', consent_call: true, consent_whatsapp: true }, { amount: true });
  assert.strictEqual(r.problem, null);
  assert.deepStrictEqual(r.row, { name: 'Meena Shah', phone: '+919876543210', amount_due: 7000,
    extra: { Student: 'Aarav', Class: '8', source: 'a call to our office' }, consent_whatsapp: true });
  assert.deepStrictEqual(AR.leadRow({ name: 'A', phone: '9876543210', consent_call: false }).row.consent_call, false);
  assert.strictEqual(AR.leadRow({ name: '', phone: '9876543210' }).problem.field, 'name');
  assert.strictEqual(AR.leadRow({ name: 'A', phone: '' }).problem.field, 'phone');
  assert.match(AR.leadRow({ name: 'A', phone: '12345' }).problem.text, /10-digit/);
  assert.strictEqual(AR.leadRow({ name: 'A', phone: '9876543210', amount: 'lots' }, { amount: true }).problem.field, 'amount');
});
test('a lead row never carries money outside Amount due', () => {
  // Without money access the amount is not sent, whatever was typed.
  assert.strictEqual(AR.leadRow({ name: 'A', phone: '9876543210', amount: '5000' }, { amount: false }).row.amount_due, null);
  assert.match(AR.leadRow({ name: 'A', phone: '9876543210', extra: { 'Fee balance': '500' } }).problem.text, /looks like money/);
  assert.strictEqual(AR.amountAllowed('fees', true), true);
  assert.strictEqual(AR.amountAllowed('fees', false), false);
  assert.strictEqual(AR.amountAllowed('sales', true), false);
});
test('what admin_add_leads said about one lead', () => {
  assert.deepStrictEqual(AR.oneLeadText([{ added: 1, bad_numbers: 0, repeats: 0, other_skipped: 0 }], 'Meena', 'Nov fees'), { ok: true, text: 'Meena added to Nov fees.' });
  assert.deepStrictEqual(AR.oneLeadText({ added: 0, repeats: 1 }, 'Meena', 'Nov fees'), { ok: false, text: 'Not added: this number is already on Nov fees.' });
  assert.match(AR.oneLeadText({ added: 0, bad_numbers: 1 }, 'M', 'L').text, /10-digit/);
  assert.match(AR.oneLeadText({ added: 0, other_skipped: 1 }, 'M', 'L').text, /check/);
});
test('a list\'s extra fields: from its leads (no money, no source keys), else the usual ones for its type', () => {
  const leads = [{ extra: { student: 'A', class: '8', source: 'x', source_date: 'y' } }, { extra: { 'Balance fee': '5', course: 'DA', student: 'B' } }, { extra: null }];
  assert.deepStrictEqual(AR.extraKeysOf(leads), ['student', 'class', 'course']);
  assert.deepStrictEqual(AR.leadFields('sales', AR.extraKeysOf(leads)), ['student', 'class', 'course']);
  assert.deepStrictEqual(AR.leadFields('fees', []), ['Student', 'Class']);
  assert.deepStrictEqual(AR.leadFields('sales', null), ['Course']);
  assert.deepStrictEqual(AR.leadFields('feedback', []), []);
  assert.deepStrictEqual(AR.leadFields('fees', ['Amount due', 'Due date']), ['Due date']);
});
test('the hand table: empty rows left out, problems by row, the same number twice', () => {
  const h = AR.handRows([
    { name: 'Asha', phone: '9876543210', extra: { Course: 'DA' } },
    { name: '', phone: '', extra: { Course: '' } },
    { name: 'Arun', phone: '98765' },
    { name: 'Asha again', phone: '+91 98765 43210' },
    { name: 'Bina', phone: '9876543211', amount: '1,200' },
  ], { amount: true });
  assert.deepStrictEqual(h.rows.map((r) => [r.name, r.phone, r.amount_due]), [['Asha', '+919876543210', null], ['Bina', '+919876543211', 1200]]);
  assert.deepStrictEqual(h.rows[0].extra, { Course: 'DA' });
  assert.deepStrictEqual(h.problems.map((p) => [p.row, p.field]), [[3, 'phone'], [4, 'phone']]);
  assert.strictEqual(h.problems[1].text, 'Row 4: same number as row 1.');
  assert.deepStrictEqual(h.counts, { filled: 4, ready: 2 });
  assert.deepStrictEqual(AR.handRows([{ name: '', phone: '' }]).counts, { filled: 0, ready: 0 });
});

// ----- templates -----
const X = require('xlsx');
// The template as a file and read back the way the import reads a file (first sheet, header row).
function roundTrip(sheets) {
  const buf = X.write(XL.build(X, sheets), { type: 'buffer', bookType: 'xlsx' });
  const wb = X.read(buf, { type: 'buffer', raw: true, cellDates: true });
  return { names: wb.SheetNames, sheet: LU.tidy(X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true })) };
}
test('the students template: headings the Fees import matches, and its example row imports', () => {
  const t = AR.studentTemplate();
  assert.deepStrictEqual(t[0].headers, ['Admission no', 'Student name', 'Class', 'Section', 'Board', 'Academic year', 'Parent name', 'Phone',
    'Alternate phone', 'Fee head 1', 'Amount 1', 'Due date 1', 'Fee head 2', 'Amount 2', 'Due date 2', 'Paid so far', 'Paid on']);
  assert.strictEqual(t[0].rows.length, 1);
  const back = roundTrip(t);
  assert.deepStrictEqual(back.names, ['Students', 'How to fill']);
  const map = F.guessImportColumns(back.sheet.header);
  F.IMPORT_FIELDS.forEach(([k]) => assert.ok(map[k] >= 0, k + ' is matched'));
  assert.strictEqual(map.fees.length, 2);
  const built = F.buildImportRows(back.sheet, map, {});
  assert.deepStrictEqual(built.problems, []);
  assert.deepStrictEqual(built.rows[0], { name: 'Aarav Shah', admission_no: 'A101', class_label: '8', section: 'A', parent_name: 'Meena Shah',
    board: 'CBSE', academic_year: '2026-27', phone: '+919876500001', paid_so_far: 5000, paid_on: '2026-04-05',
    fees: [{ head: 'Term 1 tuition', amount: 12000, due_date: '2026-04-10', academic_year: '2026-27' },
      { head: 'Term 2 tuition', amount: 10000, due_date: '2026-10-10', academic_year: '2026-27' }] });
});
test('the lead template: Name, Phone, the list\'s fields, Amount due only for a fees list with money access, Source', () => {
  assert.deepStrictEqual(AR.leadTemplate({ typeKey: 'fees', money: true })[0].headers, ['Name', 'Phone', 'Student', 'Class', 'Amount due', 'Source']);
  assert.deepStrictEqual(AR.leadTemplate({ typeKey: 'fees', money: false })[0].headers, ['Name', 'Phone', 'Student', 'Class', 'Source']);
  assert.deepStrictEqual(AR.leadTemplate({ typeKey: 'sales', money: true })[0].headers, ['Name', 'Phone', 'Course', 'Source']);
  assert.deepStrictEqual(AR.leadTemplate({ typeKey: 'event', extras: ['Child', 'Batch'] })[0].headers, ['Name', 'Phone', 'Child', 'Batch', 'Source']);
  assert.ok(!AR.leadTemplate({ typeKey: 'fees', money: false }).some((s) => JSON.stringify(s).includes('Amount due')), 'no money words without money access');
  const back = roundTrip(AR.leadTemplate({ typeKey: 'fees', money: true }));
  const map = LU.guessColumns(back.sheet.header);
  assert.deepStrictEqual([back.sheet.header[map.name], back.sheet.header[map.phone], back.sheet.header[map.amount]], ['Name', 'Phone', 'Amount due']);
  assert.deepStrictEqual(map.extra.map((i) => back.sheet.header[i]), ['Student', 'Class', 'Source']);
  const built = LU.buildLeads(back.sheet, map);
  assert.deepStrictEqual(built.rows, [{ name: 'Meena Shah', phone: '+919876500001', amount_due: 12000,
    extra: { Student: 'Aarav', Class: '8', Source: 'the enquiry form on our website' } }]);
});

// ----- static checks -----
test('the module is loaded before the tabs that use it, builds no HTML strings, and both tabs use it', () => {
  const html = fs.readFileSync(path.join(root, 'web', 'admin.html'), 'utf8');
  const at = (f) => html.indexOf('<script src="' + f + '"></script>');
  assert.ok(at('js/admin/add-row.js') > at('js/lead-upload.js') && at('js/lead-upload.js') > -1);
  assert.ok(at('js/admin/add-row.js') < at('js/admin/campaigns.js') && at('js/admin/add-row.js') < at('js/admin/fees.js'));
  assert.ok(at('js/excel-export.js') > -1 && at('js/excel-export.js') < at('js/admin/add-row.js'));
  const src = fs.readFileSync(path.join(root, 'web', 'js', 'admin', 'add-row.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\beval\(|style=/.test(src));
  const fees = fs.readFileSync(path.join(root, 'web', 'js', 'admin', 'fees.js'), 'utf8');
  const camp = fs.readFileSync(path.join(root, 'web', 'js', 'admin', 'campaigns.js'), 'utf8');
  assert.ok(/accounts_save_student/.test(fees) && /'\+ Add student'/.test(fees) && /'Import from Excel'/.test(fees));
  assert.ok(/'\+ Add lead'/.test(camp) && /'\+ Add by hand'/.test(camp) && /'Import from Excel'/.test(camp));
});
