/* Interface text in English and Hindi, for the workspace labels only. Hindi is a DRAFT: a native speaker
   must review every Hindi string before it is offered as final.
   Lookup falls back to English when a Hindi string is missing, and to the key itself when neither has it.
   Elements with data-i18n="key" get their text; data-i18n-placeholder="key" sets a placeholder.
   Nothing here touches lead data. */
(function (root) {
  const STRINGS = {
    en: {
      "practice.start": "Practice",
      "practice.banner": "Practice: nothing is saved",
      "practice.exit": "Exit practice",
      "practice.blocked": "Exit practice before changing lead or saving a call.",
      "practice.blockedStart": "Finish the call first, then practise.",
      "consent.label": "Consent",
      "consent.none": "Not recorded",
      "consent.given": "Consent given",
      "consent.refused": "Consent refused",
      "consent.hint": "Saved on this lead's row in the sheet. Never sent to the cloud.",
      "consent.on": "Recorded on {date}.",
      "terms.title": "Terms of use",
      "terms.needed": "Accept the terms before you make calls.",
      "terms.draft": "Draft: needs legal review before use.",
      "terms.accept": "I accept these terms",
      "terms.saved": "Terms accepted. You can make calls now.",
      "terms.error": "Could not save your acceptance. Check the connection and try again.",
      "call.blockedTerms": "Accept the terms first. See the panel at the top of the page.",
      "feedback.open": "Send feedback",
      "feedback.title": "Send feedback",
      "feedback.hint": "Tell us what would help. Do not include lead names or phone numbers.",
      "feedback.label": "Your message",
      "feedback.count": "{n} of {max} characters",
      "feedback.send": "Send",
      "feedback.cancel": "Cancel",
      "feedback.sent": "Thank you. Your feedback was sent.",
      "feedback.empty": "Write a message first.",
      "feedback.error": "Could not send feedback. Check the connection and try again.",
      "feedback.offCloud": "Feedback needs the Vector cloud, which is not set up on this site.",
      "timeout.title": "Still there?",
      "timeout.text": "Nothing has happened for 30 minutes. If you do not respond, you will be signed out in 5 minutes.",
      "timeout.textOff": "Nothing has happened for 30 minutes. Your results are still saved in this browser.",
      "timeout.continue": "Continue",
      "timeout.signedOut": "You were signed out after 35 minutes with no activity. Sign in again to keep syncing.",
      "settings.open": "Settings",
      "settings.large": "Large text",
      "settings.contrast": "High contrast",
      "settings.language": "Language",
      "settings.lang.en": "English",
      "settings.lang.hi": "Hindi (draft, needs review)",
      "settings.walkthrough": "Show the walkthrough again",
      "onb.count": "Step {n} of {total}",
      "onb.next": "Next",
      "onb.done": "Done",
      "onb.skip": "Skip",
      "onb.1.title": "Pair the phone",
      "onb.1.body": "On the phone, open Vector Companion and show the pairing code. Scan it here, or type the address and code. The phone and this laptop need the same Wi-Fi.",
      "onb.2.title": "Import your leads",
      "onb.2.body": "Load an Excel or CSV sheet with a name and a phone column. The sheet stays in this browser.",
      "onb.3.title": "Use the script",
      "onb.3.body": "Read the line on screen, then tap the answer you heard. Use Practice to walk the script without saving anything.",
      "onb.4.title": "Send outcomes",
      "onb.4.body": "Tap the outcome at the end of each call. Download the results file when you finish. Lead names and numbers never leave this laptop.",
      "btn.back": "‹ Back one step",
      "btn.restart": "Start a new call",
      "btn.loadSheet": "Load a lead sheet",
      "btn.download": "Download results (.xlsx)",
      "btn.nextLead": "Next lead",
      "btn.copy": "Copy message",
      "btn.undo": "Undo this outcome",
      "btn.signOut": "Sign out",
      "btn.call": "Call {first}",
      "btn.callPlain": "Call",
      "btn.callPhone": "Call via phone link"
    },
    hi: {
      "practice.start": "अभ्यास",
      "practice.banner": "अभ्यास: कुछ भी सेव नहीं होता",
      "practice.exit": "अभ्यास बंद करें",
      "practice.blocked": "लीड बदलने और कॉल सेव करने से पहले अभ्यास बंद करें।",
      "practice.blockedStart": "पहले कॉल पूरी करें, फिर अभ्यास करें।",
      "consent.label": "सहमति",
      "consent.none": "दर्ज नहीं",
      "consent.given": "सहमति मिली",
      "consent.refused": "सहमति नहीं मिली",
      "consent.hint": "इस लीड की पंक्ति में शीट में सेव होता है। कभी क्लाउड पर नहीं भेजा जाता।",
      "consent.on": "{date} को दर्ज हुआ।",
      "terms.title": "उपयोग की शर्तें",
      "terms.needed": "कॉल करने से पहले शर्तें स्वीकार करें।",
      "terms.draft": "ड्राफ़्ट: उपयोग से पहले कानूनी समीक्षा ज़रूरी है।",
      "terms.accept": "मैं इन शर्तों को स्वीकार करता/करती हूँ",
      "terms.saved": "शर्तें स्वीकार हुईं। अब आप कॉल कर सकते हैं।",
      "terms.error": "आपकी स्वीकृति सेव नहीं हो सकी। कनेक्शन जाँचें और फिर कोशिश करें।",
      "call.blockedTerms": "पहले शर्तें स्वीकार करें। पेज के ऊपर का पैनल देखें।",
      "feedback.open": "फ़ीडबैक भेजें",
      "feedback.title": "फ़ीडबैक भेजें",
      "feedback.hint": "बताएँ किस चीज़ से मदद मिलेगी। लीड के नाम या फ़ोन नंबर न लिखें।",
      "feedback.label": "आपका संदेश",
      "feedback.count": "{max} में से {n} अक्षर",
      "feedback.send": "भेजें",
      "feedback.cancel": "रद्द करें",
      "feedback.sent": "धन्यवाद। आपका फ़ीडबैक भेज दिया गया।",
      "feedback.empty": "पहले कुछ लिखें।",
      "feedback.error": "फ़ीडबैक नहीं भेजा जा सका। कनेक्शन जाँचें और फिर कोशिश करें।",
      "feedback.offCloud": "फ़ीडबैक के लिए Vector क्लाउड चाहिए, जो इस साइट पर सेट नहीं है।",
      "timeout.title": "क्या आप यहाँ हैं?",
      "timeout.text": "30 मिनट से कोई गतिविधि नहीं हुई। जवाब न दिया तो 5 मिनट में आप साइन आउट हो जाएँगे।",
      "timeout.textOff": "30 मिनट से कोई गतिविधि नहीं हुई। आपके नतीजे इस ब्राउज़र में अभी भी सेव हैं।",
      "timeout.continue": "जारी रखें",
      "timeout.signedOut": "35 मिनट तक कोई गतिविधि न होने पर आप साइन आउट हो गए। सिंक जारी रखने के लिए फिर से साइन इन करें।",
      "settings.open": "सेटिंग्स",
      "settings.large": "बड़ा अक्षर",
      "settings.contrast": "उच्च कंट्रास्ट",
      "settings.language": "भाषा",
      "settings.lang.en": "English",
      "settings.lang.hi": "हिन्दी (ड्राफ़्ट, समीक्षा बाकी)",
      "settings.walkthrough": "परिचय फिर से दिखाएँ",
      "onb.count": "चरण {n} / {total}",
      "onb.next": "आगे",
      "onb.done": "हो गया",
      "onb.skip": "छोड़ें",
      "onb.1.title": "फ़ोन जोड़ें",
      "onb.1.body": "फ़ोन पर Vector Companion खोलें और पेरिंग कोड दिखाएँ। यहाँ उसे स्कैन करें, या पता और कोड टाइप करें। फ़ोन और लैपटॉप एक ही Wi-Fi पर हों।",
      "onb.2.title": "लीड इम्पोर्ट करें",
      "onb.2.body": "नाम और फ़ोन कॉलम वाली Excel या CSV शीट लोड करें। शीट इसी ब्राउज़र में रहती है।",
      "onb.3.title": "स्क्रिप्ट इस्तेमाल करें",
      "onb.3.body": "स्क्रीन पर लिखी लाइन पढ़ें, फिर सुना हुआ जवाब चुनें। बिना कुछ सेव किए स्क्रिप्ट देखने के लिए अभ्यास इस्तेमाल करें।",
      "onb.4.title": "नतीजे भेजें",
      "onb.4.body": "हर कॉल के अंत में नतीजा चुनें। खत्म होने पर नतीजों की फ़ाइल डाउनलोड करें। लीड के नाम और नंबर इस लैपटॉप से कभी बाहर नहीं जाते।",
      "btn.back": "‹ एक कदम पीछे",
      "btn.restart": "नई कॉल शुरू करें",
      "btn.loadSheet": "लीड शीट लोड करें",
      "btn.download": "नतीजे डाउनलोड करें (.xlsx)",
      "btn.nextLead": "अगली लीड",
      "btn.copy": "संदेश कॉपी करें",
      "btn.undo": "यह नतीजा वापस लें",
      "btn.signOut": "साइन आउट",
      "btn.call": "{first} को कॉल करें",
      "btn.callPlain": "कॉल करें",
      "btn.callPhone": "फ़ोन के ज़रिए कॉल करें"
    }
  };
  const LANGS = ["en", "hi"];
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  let current = "en";

  /* Pure: the text for key in lang, falling back to English, then to the key. {name} parts come from vars. */
  function translate(key, lang, vars) {
    const want = STRINGS[lang] || {};
    let text;
    if (has(want, key)) text = want[key];
    else if (has(STRINGS.en, key)) text = STRINGS.en[key];
    else return key;
    if (vars) text = text.replace(/\{(\w+)\}/g, (m, name) => (has(vars, name) ? String(vars[name]) : m));
    return text;
  }
  function normalize(lang) { return LANGS.includes(lang) ? lang : "en"; }
  function setLang(lang) { current = normalize(lang); }
  /* Sets the text of every [data-i18n] element in the document (or the given root) for the current language. */
  function apply(doc) {
    const d = doc || root.document;
    d.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = translate(node.dataset.i18n, current); });
    d.querySelectorAll("[data-i18n-placeholder]").forEach((node) => { node.placeholder = translate(node.dataset.i18nPlaceholder, current); });
  }

  root.I18n = {
    STRINGS: STRINGS,
    LANGS: LANGS,
    translate: translate,
    normalize: normalize,
    setLang: setLang,
    lang: () => current,
    t: (key, vars) => translate(key, current, vars),
    apply: apply,
  };
})(window);
