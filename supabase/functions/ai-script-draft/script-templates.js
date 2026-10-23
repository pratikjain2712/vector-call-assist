/* Starter scripts for the Scripts tab ("Start from a template") and examples for the AI script maker.
   Pure data in the script-model.js format: { key, name, call_type, about, steps, pushbacks }. call_type is a
   built-in call type key (docs/data-contract.md); every ending's "result" is a result key of that type.
   Facts that differ by institute (fee, dates, course details) are not written in: the step carries a
   "Check this" mark instead, so the admin adds them before the script can be published.
   Stages are the call page's progress rail (web/js/main.js STAGES): 0 Opening, 1 Discovery, 2 Pitch,
   3 Timings, 4 Fee, 5 Close. At most 3 options a step.
   Loads as window.ScriptTemplates in the browser and as module.exports in Node (tests/web/script-templates.test.js).
   supabase/functions/ai-script-draft/script-templates.js is an exact copy (the Edge Function cannot load files
   from web/); tests/web/ai-script-draft.test.js fails when the two differ. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScriptTemplates = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TEMPLATES = [
    {
      key: 'fees_reminder',
      name: 'Fees reminder',
      call_type: 'fees',
      about: 'Remind a parent that a fee is due and get a date when they will pay.',
      steps: [
        { id: 'open', title: 'Opening', start: true, stage: 0,
          say: ['Hello, am I speaking with {name}?'],
          tip: 'Smile before you speak. Speak slowly.',
          opts: [{ label: 'Yes', to: 'reason' }, { label: 'Wrong person', to: 'wrong' }, { label: 'Busy now', to: 'later' }] },
        { id: 'reason', title: 'Reminder', stage: 1,
          say: ['This is {me} from the school office.', 'I am calling about this term\'s fee. It is due soon.'],
          check: ['Add the fee amount and the due date, the way callers should say them.'],
          opts: [{ label: 'Will pay', to: 'when' }, { label: 'Already paid', to: 'already' }, { label: 'Has a problem', to: 'problem' }] },
        { id: 'when', title: 'Pay date', stage: 3,
          say: ['Thank you. On which date can you pay?', 'You can pay at the office.'],
          tip: 'Get a date. Repeat it back to them.',
          check: ['Write every way to pay that your institute accepts.'],
          opts: [{ label: 'Gives a date', to: 'promise' }, { label: 'Not sure', to: 'problem' }] },
        { id: 'problem', title: 'Problem', stage: 4,
          say: ['I understand. Thank you for telling me.', 'Can you pay a part now and the rest later?'],
          tip: 'Listen first. Do not argue.',
          opts: [{ label: 'Can pay later', to: 'promise' }, { label: 'Cannot pay', to: 'refused' }, { label: 'Stop calling', to: 'stop' }] },
        { id: 'promise', title: 'Will pay on date', stage: 5, result: 'will_pay_on',
          say: ['Thank you. I have noted the date and the amount.', 'Have a good day, {name}.'] },
        { id: 'already', title: 'Says already paid', stage: 5, result: 'already_paid',
          say: ['Thank you! I will check this with the office.', 'If you have the receipt number, please tell me.'] },
        { id: 'refused', title: 'Cannot pay', stage: 5, result: 'refused',
          say: ['I understand. I will tell the office.', 'Thank you for your time, {name}.'] },
        { id: 'wrong', title: 'Wrong person', stage: 5, result: 'wrong_number',
          say: ['Sorry to trouble you. Have a good day.'] },
        { id: 'later', title: 'Call back later', stage: 5, result: 'call_back_later',
          say: ['No problem. When can I call you back?'] },
        { id: 'stop', title: 'Do not call again', stage: 5, result: 'do_not_call',
          say: ['Sorry for the trouble. We will not call you again.', 'Have a good day.'] },
      ],
      pushbacks: [
        { label: 'We already paid', answer: 'Thank you. Please tell me the date you paid or the receipt number. I will check with the office.' },
        { label: 'Money is tight this month', answer: 'I understand. Tell me a date that works for you and I will note it down.' },
        { label: 'Talk to my husband or wife', answer: 'Sure. When can I call back to speak with them?' },
        { label: 'Can I pay in parts?', answer: 'Let me check this with the office and call you back.',
          check: ['Write your rule for paying in parts, or remove this answer.'] },
      ],
    },
    {
      key: 'course_sales',
      name: 'Course sales',
      call_type: 'sales',
      about: 'Call a person who asked about a course and help them decide.',
      steps: [
        { id: 'open', title: 'Opening', start: true, stage: 0,
          say: ['Hello, am I speaking with {name}?'],
          tip: 'Smile before you speak. Speak slowly.',
          opts: [{ label: 'Yes', to: 'intro' }, { label: 'Wrong person', to: 'wrong' }, { label: 'Busy now', to: 'later' }] },
        { id: 'intro', title: 'Introduction', stage: 0,
          say: ['Hi {name}, this is {me}.', 'You asked about our course. Do you have two minutes?'],
          opts: [{ label: 'Yes', to: 'need' }, { label: 'Not now', to: 'later' }, { label: 'Stop calling', to: 'stop' }] },
        { id: 'need', title: 'What they want', stage: 1,
          say: ['What do you want to learn, and why?'],
          tip: 'Let them talk. Note what they say.',
          opts: [{ label: 'Told me', to: 'pitch' }] },
        { id: 'pitch', title: 'The course', stage: 2,
          say: ['Thank you. Our course can help with that.', 'Would you like to join?'],
          check: ['Add the course name, how long it runs, the class times and the fee, the way callers should say them.'],
          opts: [{ label: 'Wants to join', to: 'joined' }, { label: 'Wants to think', to: 'think' }, { label: 'Not for them', to: 'no' }] },
        { id: 'joined', title: 'Joined', stage: 5, result: 'joined',
          say: ['Great! I will send the joining steps on WhatsApp now.', 'Welcome, {name}!'] },
        { id: 'think', title: 'Will think', stage: 5, result: 'will_think',
          say: ['Sure. I will send the details on WhatsApp.', 'Can I call you again in two days?'] },
        { id: 'no', title: 'Not interested', stage: 5, result: 'not_interested',
          say: ['No problem. Thank you for your time, {name}.'] },
        { id: 'wrong', title: 'Wrong person', stage: 5, result: 'wrong_number',
          say: ['Sorry to trouble you. Have a good day.'] },
        { id: 'later', title: 'Call back later', stage: 5, result: 'call_back_later',
          say: ['No problem. When can I call you back?'] },
        { id: 'stop', title: 'Do not call again', stage: 5, result: 'do_not_call',
          say: ['Sorry for the trouble. We will not call you again.', 'Have a good day.'] },
      ],
      pushbacks: [
        { label: 'It costs too much', answer: 'I understand. Can I tell you what is included in the fee?',
          check: ['Add what the fee includes and any way to pay in parts.'] },
        { label: 'I have no time', answer: 'I understand. Can I tell you the class times? Some people join on weekends.',
          check: ['Add your real class times.'] },
        { label: 'Will I get a job?', answer: 'We do not promise a job. We help you learn the skills and prepare for interviews.',
          check: ['Write only what your institute really offers for jobs. Never promise a job.'] },
        { label: 'Send me the details', answer: 'Sure, I will send them on WhatsApp now. Can I call you after you read them?' },
      ],
    },
    {
      key: 'admission_follow_up',
      name: 'Admission follow-up',
      call_type: 'admission',
      about: 'Follow up an admission enquiry and book a visit or send the form.',
      steps: [
        { id: 'open', title: 'Opening', start: true, stage: 0,
          say: ['Hello, am I speaking with {name}?'],
          tip: 'Smile before you speak. Speak slowly.',
          opts: [{ label: 'Yes', to: 'intro' }, { label: 'Wrong person', to: 'wrong' }, { label: 'Busy now', to: 'later' }] },
        { id: 'intro', title: 'Introduction', stage: 1,
          say: ['This is {me} from the admissions office.', 'You asked about admission. Are you still looking for a seat this year?'],
          opts: [{ label: 'Yes', to: 'visit' }, { label: 'Joined elsewhere', to: 'elsewhere' }, { label: 'Not this year', to: 'next_year' }] },
        { id: 'visit', title: 'Visit or form', stage: 3,
          say: ['Would you like to visit us and see the place?', 'I can also send the admission form on WhatsApp.'],
          check: ['Add your visiting days, hours and address.'],
          opts: [{ label: 'Book a visit', to: 'booked' }, { label: 'Send the form', to: 'form' }, { label: 'Stop calling', to: 'stop' }] },
        { id: 'booked', title: 'Visit booked', stage: 5, result: 'visit_booked',
          say: ['Great! Which day suits you?', 'I will send the address on WhatsApp. See you soon, {name}.'] },
        { id: 'form', title: 'Form sent', stage: 5, result: 'form_sent',
          say: ['Sure. I am sending the form on WhatsApp now.', 'Call us if you have any question.'] },
        { id: 'elsewhere', title: 'Joined elsewhere', stage: 5, result: 'joined_elsewhere',
          say: ['Thank you for telling me. All the best, {name}.'] },
        { id: 'next_year', title: 'Not this year', stage: 5, result: 'not_this_year',
          say: ['No problem. Thank you for your time, {name}.'] },
        { id: 'wrong', title: 'Wrong person', stage: 5, result: 'wrong_number',
          say: ['Sorry to trouble you. Have a good day.'] },
        { id: 'later', title: 'Call back later', stage: 5, result: 'call_back_later',
          say: ['No problem. When can I call you back?'] },
        { id: 'stop', title: 'Do not call again', stage: 5, result: 'do_not_call',
          say: ['Sorry for the trouble. We will not call you again.', 'Have a good day.'] },
      ],
      pushbacks: [
        { label: 'What is the fee?', answer: 'I will send the fee details with the form on WhatsApp.',
          check: ['Add the fee, or keep this answer if callers should not say it on the phone.'] },
        { label: 'I need to ask my family', answer: 'Of course. When can I call back to talk with them?' },
        { label: 'Is there a hostel or bus?', answer: 'Let me check and send you the details on WhatsApp.',
          check: ['Add what your institute offers: hostel, bus or neither.'] },
      ],
    },
  ];

  // A deep copy of one template by key, safe to change, or null.
  function template(key) {
    const t = TEMPLATES.find((x) => x.key === key);
    return t ? JSON.parse(JSON.stringify(t)) : null;
  }

  return { TEMPLATES, template };
}));
