/*DATA*/
const STAGES = ["Opening", "Discovery", "Pitch", "Timings", "Fee", "Close"];
const SITE = "https://vector.techsimplus.com/";

let FLOW = {
  open: { stage: 0, say: ["Hi, is this {name}?"], tip: "Smile before you speak. Slow down.",
    opts: [{ k: "yes", hint: "It is them", to: "intro" }, { k: "no", hint: "Wrong person picked up", to: "wrong_person" }, { k: "maybe", hint: "“Who is this?”", to: "intro" }] },
  wrong_person: { stage: 0, say: ["Oh, sorry! Is {name} there?"],
    opts: [{ k: "yes", hint: "Hands the phone over", to: "intro" }, { k: "no", hint: "Wrong number", to: "exit_wrong" }, { k: "maybe", hint: "Not available right now", to: "callback" }] },
  intro: { stage: 0, say: ["Hi {name}, {me} here, from TechSimPlus.", "You recently enquired about Vector 2.0, our Gen-AI program for working professionals. Is this a good time to talk?"],
    opts: [{ k: "yes", hint: "Can talk", to: "frame" }, { k: "no", hint: "Busy", to: "callback" }, { k: "maybe", hint: "“What is this about?”", to: "intro_maybe" }] },
  intro_maybe: { stage: 0, say: ["Sure. We run a live Gen-AI course, Vector 2.0.", "I want to check if it is useful for you. Can I ask two quick questions?"],
    opts: [{ k: "yes", hint: "Go ahead", to: "q_work" }, { k: "no", hint: "Not interested", to: "ni_soft" }, { k: "maybe", hint: "Not now", to: "callback" }] },
  frame: { stage: 0, say: ["Thanks! I will keep this short.", "I just want to see if this course is right for you. If it is not, I will tell you honestly. Is that okay?"],
    opts: [{ k: "yes", hint: "Okay", to: "q_curriculum" }, { k: "no", hint: "Not interested", to: "ni_soft" }, { k: "maybe", hint: "Hesitant, still listening", to: "q_curriculum" }] },
  ni_soft: { stage: 0, say: ["No problem. Just one question before I go.", "Are you thinking of moving into Gen-AI in your career?"], tip: "One try only. If it is still no, let them go.",
    opts: [{ k: "yes", hint: "It is", to: "q_work" }, { k: "no", hint: "No", to: "exit_polite" }, { k: "maybe", hint: "“Just send me details”", to: "send_details" }] },
  send_details: { stage: 0, say: ["Sure, I will WhatsApp it to you.", "Can I call you again in two or three days?"],
    opts: [{ k: "yes", hint: "Okay", to: "end_details" }, { k: "no", hint: "Do not call", to: "followup_n" }, { k: "maybe", hint: "“I will see”", to: "end_details" }] },
  callback: { stage: 0, say: ["No problem. When is a good time? This evening, or tomorrow?"], tip: "Write the time down before you hang up.",
    opts: [{ k: "yes", hint: "Gave a time", to: "callback_ok" }, { k: "no", hint: "“Do not call back”", to: "exit_dnc" }, { k: "maybe", hint: "“Just message me”", to: "followup_n" }] },
  callback_ok: { stage: 0, say: ["Perfect, I will call you then. Thanks, {name}!"],
    opts: [{ k: "next", hint: "Call finished", to: "end_callback" }] },

  q_curriculum: { stage: 1, say: ["Before I start, did you get a chance to check the course curriculum?"],
    opts: [{ k: "yes", hint: "Checked it", to: "curr_yes" }, { k: "no", hint: "Not yet", to: "q_work" }, { k: "maybe", hint: "Skimmed it", to: "q_work" }] },
  curr_yes: { stage: 1, say: ["Great. Anything you would like to discuss before deciding?", "And if you have technical questions, I can set up a call with our tech team."], tip: "Note their questions. Answer what you can from the worries below.",
    opts: [{ k: "yes", hint: "Wants a tech team call", to: "techcall" }, { k: "no", hint: "No questions, continue", to: "q_work" }, { k: "maybe", hint: "Asked something, answered it", to: "q_work" }] },
  techcall: { stage: 1, say: ["Sure, I will set that up. When suits you, this evening or tomorrow?", "Till then, can I ask you two quick questions?"], tip: "Write the time and their question down before you move on.",
    opts: [{ k: "yes", hint: "Gave a time, happy to continue", to: "q_work" }, { k: "no", hint: "Gave a time, has to go", to: "end_techcall" }, { k: "maybe", hint: "Will message a time", to: "end_techcall" }] },
  q_work: { stage: 1, say: ["So, what do you do right now?", "And how many years of experience do you have?"], tip: "Let them talk. Note the role and years. You will use it in the pitch.",
    opts: [{ k: "yes", hint: "Working developer or engineer", to: "q_python" }, { k: "no", hint: "Student or fresher", to: "fresher" }, { k: "maybe", hint: "Non-coding role", to: "q_python" }] },
  fresher: { stage: 1, say: ["Okay. I will be honest, this is made for working engineers.", "But if your Python is good, you can still do it. How is your Python?"],
    opts: [{ k: "yes", hint: "Good", to: "q_genai" }, { k: "no", hint: "Weak or none", to: "python_no" }, { k: "maybe", hint: "Basic", to: "python_maybe" }] },
  q_python: { stage: 1, say: ["Nice. Are you comfortable with Python?"],
    opts: [{ k: "yes", hint: "Writes Python", to: "q_genai" }, { k: "no", hint: "Does not code in Python", to: "python_no" }, { k: "maybe", hint: "A little", to: "python_maybe" }] },
  python_no: { stage: 1, say: ["Okay, I will be honest. This course needs Python.", "If you know any other language, we give you recorded Python lectures. You finish them before 21 November. Can you do that?"],
    opts: [{ k: "yes", hint: "Will do it", to: "q_genai" }, { k: "no", hint: "Not ready", to: "exit_notfit" }, { k: "maybe", hint: "Unsure", to: "q_genai" }] },
  python_maybe: { stage: 1, say: ["That is okay. We give you recorded Python lectures to finish before classes start. You will be fine."],
    opts: [{ k: "next", hint: "Next question", to: "q_genai" }] },
  q_genai: { stage: 1, say: ["Have you tried learning Gen-AI before?", "From YouTube, or any course?"],
    opts: [{ k: "yes", hint: "Tried something", to: "q_scale" }, { k: "no", hint: "Nothing yet", to: "genai_no" }, { k: "maybe", hint: "Did a course, it was a waste", to: "burned" }] },
  genai_no: { stage: 1, say: ["Perfect, this course is made for people like you.", "We start from the basics, and go step by step."],
    opts: [{ k: "next", hint: "Next question", to: "q_goal" }] },
  burned: { stage: 1, say: ["Many people tell me the same. What was the problem?", "Was it all recorded videos?"], tip: "Let them talk. Do not defend courses.",
    opts: [{ k: "yes", hint: "Recorded, no support", to: "burned_yes" }, { k: "no", hint: "Does not trust any course now", to: "trust" }, { k: "maybe", hint: "Mixed reasons", to: "burned_yes" }] },
  burned_yes: { stage: 1, say: ["Yes, that happens a lot.", "This course is live. There are deadlines. And a mentor checks your work."],
    opts: [{ k: "next", hint: "Next question", to: "q_goal" }] },
  trust: { stage: 1, say: ["I understand. You do not have to just trust me.", "There is a 3-day refund, no questions asked. So there is no risk. Shall I tell you more?"],
    opts: [{ k: "yes", hint: "Okay", to: "q_goal" }, { k: "no", hint: "No", to: "exit_polite" }, { k: "maybe", hint: "Go on", to: "q_goal" }] },
  q_scale: { stage: 1, say: ["Okay. Suppose an interviewer asks you, “How do you scale this to a million users?”", "Could you answer that today?"], tip: "If they say no, this is what the course fixes. Remember it.",
    opts: [{ k: "yes", hint: "Does this in production", to: "experienced" }, { k: "no", hint: "Would struggle", to: "q_goal" }, { k: "maybe", hint: "Partly", to: "q_goal" }] },
  experienced: { stage: 1, say: ["Very good. Then the first few weeks will be revision for you.", "Later it is LangGraph, agentic AI, MCP servers, AWS Bedrock, and deploying with Docker and CI/CD. Have you done all of that in real projects?"],
    opts: [{ k: "yes", hint: "All of it", to: "exit_notfit" }, { k: "no", hint: "Some gaps", to: "q_goal" }, { k: "maybe", hint: "Not all", to: "q_goal" }] },
  q_goal: { stage: 1, say: ["What is your plan? Do you want to move into a Gen-AI role?"],
    opts: [{ k: "yes", hint: "Wants to move to Gen-AI", to: "pitch1" }, { k: "no", hint: "Just exploring", to: "goal_no" }, { k: "maybe", hint: "Open to it", to: "pitch1" }] },
  goal_no: { stage: 1, say: ["Okay. But more and more jobs now ask for Gen-AI.", "Would real projects on your GitHub help you when you change jobs?"],
    opts: [{ k: "yes", hint: "It would", to: "pitch1" }, { k: "no", hint: "Happy in current job", to: "goal_no2" }, { k: "maybe", hint: "Possibly", to: "pitch1" }] },
  goal_no2: { stage: 1, say: ["Okay, no problem.", "Can I just WhatsApp you the details, in case you change your mind?"],
    opts: [{ k: "yes", hint: "Sure", to: "end_details" }, { k: "no", hint: "No need", to: "exit_polite" }, { k: "maybe", hint: "Fine", to: "end_details" }] },

  pitch1: { stage: 2, say: ["Okay, let me tell you about the course.", "It is a 3-month live course for working professionals. Prateek Mishra teaches it. He is a senior Gen-AI developer at an MNC, with 8 years of experience.", "He teaches what he actually builds at work. Is that clear so far?"], tip: "Open with their own words: their role, their goal, the thing they said they struggle with.",
    opts: [{ k: "yes", hint: "Following", to: "pitch2" }, { k: "no", hint: "“Never heard of him”", to: "trust_brand" }, { k: "maybe", hint: "Quiet, listening", to: "pitch2" }] },
  trust_brand: { stage: 2, say: ["Yes, we are not a big brand.", "He has taught over 12,000 engineers, and his LinkedIn is public. I will send it to you. Shall I continue?"],
    opts: [{ k: "yes", hint: "Go on", to: "pitch2" }, { k: "no", hint: "Not convinced", to: "exit_polite" }, { k: "maybe", hint: "Okay", to: "pitch2" }] },
  pitch2: { stage: 2, say: ["You learn LangChain, LangGraph, agentic AI, RAG, MCP servers and AWS Bedrock.", "And you build five production-level apps, deployed on AWS. Not small practice projects. These projects help your resume get shortlisted.", "One answers questions from RBI circulars. The biggest one can handle 10 million requests a day. Does that sound interesting?"], tip: "Pause after each project. Do not rush the list.",
    opts: [{ k: "yes", hint: "Interested", to: "pitch3" }, { k: "no", hint: "Not relevant to them", to: "pitch_no" }, { k: "maybe", hint: "Neutral", to: "pitch3" }] },
  pitch3: { stage: 2, say: ["And the best part is this. Five mock interviews, one-on-one, with real Gen-AI developers. Written feedback in 24 hours.", "You also get a personal mentor. Any doubt, any time, you just ask.", "Then a Demo Day with hiring partners.", "So when you go for a real interview, you have already practised five times. Is this what you were looking for?"],
    opts: [{ k: "yes", hint: "Yes", to: "time" }, { k: "no", hint: "Not convinced", to: "pitch_no" }, { k: "maybe", hint: "“What is different?”", to: "diff" }] },
  diff: { stage: 2, say: ["Good question. There are three differences.", "It is live, not recorded. Every project is deployed on AWS, and on your GitHub. Five mock interviews, one-on-one. And a personal mentor for your doubts.", "Shall I tell you the timings?"],
    opts: [{ k: "yes", hint: "Wants timings", to: "time" }, { k: "no", hint: "Still not convinced", to: "pitch_no" }, { k: "maybe", hint: "Okay", to: "time" }] },
  pitch_no: { stage: 2, say: ["No problem. What is stopping you?", "Please tell me honestly."], tip: "Listen fully. Then tap the matching worry below.",
    opts: [{ k: "yes", hint: "Worry answered, interested again", to: "time" }, { k: "no", hint: "Still a no", to: "exit_polite" }, { k: "maybe", hint: "Wants to think", to: "followup" }] },

  time: { stage: 3, say: ["The timings are made for working people.", "Two weekday classes, two hours each. Morning 6:30 to 8:30, or night 8 to 10.", "Weekends, a longer class, 10 to 4, with a 30-minute break. Can you manage this?"], tip: "They can switch between the morning and evening batch any time. Same topic, same mentor.",
    opts: [{ k: "yes", hint: "Can manage", to: "fee" }, { k: "no", hint: "Too much", to: "time_no" }, { k: "maybe", hint: "Worried about busy weeks", to: "time_no" }] },
  time_no: { stage: 3, say: ["I understand, it is a lot.", "But everything is recorded. The recording comes within 24 hours, and you can watch it for life. If you miss a class, you can watch it later. Does that help?"],
    opts: [{ k: "yes", hint: "That helps", to: "fee" }, { k: "no", hint: "Still cannot", to: "time_no2" }, { k: "maybe", hint: "Probably", to: "fee" }] },
  time_no2: { stage: 3, say: ["Okay. Which part is the problem? Weekdays, or weekends?", "And you can switch between the morning and evening batch whenever you need."], tip: "Weekdays: recordings and batch switching cover it. Weekends: that is the long class, they should attend most of them.",
    opts: [{ k: "yes", hint: "Can adjust", to: "fee" }, { k: "no", hint: "Cannot give the time", to: "exit_later" }, { k: "maybe", hint: "Needs to check", to: "followup" }] },
  exit_later: { stage: 3, say: ["I understand. It is better to join when you have the time.", "I will WhatsApp you the details, in case you get more time later. Thanks, {name}."],
    opts: [{ k: "next", hint: "Call finished", to: "end_details" }] },

  fee: { stage: 4, say: ["So, the fee. It is ₹25,000.", "But till 30 October, it is ₹20,000. Everything is included."], tip: "Now stop talking. Let them speak first.",
    opts: [{ k: "yes", hint: "Fine with it", to: "close" }, { k: "no", hint: "Too expensive", to: "fee_no" }, { k: "maybe", hint: "Silent, or “hmm”", to: "fee_maybe" }] },
  fee_maybe: { stage: 4, say: ["And there is a 3-day refund, no questions asked.", "So if you do not like it, you get your money back. Is that okay?"],
    opts: [{ k: "yes", hint: "Okay", to: "close" }, { k: "no", hint: "Still too much", to: "fee_no" }, { k: "maybe", hint: "Wants to think", to: "think" }] },
  fee_no: { stage: 4, say: ["I understand. ₹20,000 is a big amount.", "You can pay in two parts. ₹6,000 to join, and the rest within 15 days. Does that help?"],
    opts: [{ k: "yes", hint: "Instalments work", to: "close" }, { k: "no", hint: "Still too much", to: "fee_no2" }, { k: "maybe", hint: "Needs to think", to: "think" }] },
  fee_no2: { stage: 4, say: ["Okay. Can I ask, if money was not the issue, would you join?"],
    opts: [{ k: "yes", hint: "Yes, only the fee", to: "fee_only" }, { k: "no", hint: "Not sure about the course", to: "pitch_no" }, { k: "maybe", hint: "Needs to think", to: "think" }] },
  fee_only: { stage: 4, say: ["Okay, so it is only the fee.", "I cannot promise anything more. But let me check with my team, and I will message you today. Is that okay?"], tip: "Do not promise a discount. The two instalments are the only option you can offer.",
    opts: [{ k: "yes", hint: "Fine", to: "end_followup" }, { k: "no", hint: "Leave it", to: "exit_polite" }, { k: "maybe", hint: "Okay", to: "end_followup" }] },

  close: { stage: 5, say: ["Honestly, I think you are a good fit. Registrations close on 11 November.", "Shall I WhatsApp you the link now? You get the ₹20,000 price, and you can start with just ₹6,000."],
    opts: [{ k: "yes", hint: "Send it", to: "won" }, { k: "no", hint: "Not now", to: "think" }, { k: "maybe", hint: "“Let me think”", to: "think" }] },
  won: { stage: 5, say: ["Great, I am sending it now. This is your WhatsApp number, right?", "I will message you tomorrow. Welcome to Vector 2.0, {name}!"],
    opts: [{ k: "next", hint: "Call finished", to: "end_won" }] },
  think: { stage: 5, say: ["Sure, take your time.", "Just tell me, what is stopping you? Time, fee, or the content?"], tip: "Answer it from the worries below, then come back.",
    opts: [{ k: "yes", hint: "Doubt cleared, ready to join", to: "won" }, { k: "no", hint: "Firm no", to: "exit_polite" }, { k: "maybe", hint: "Still wants time", to: "followup" }] },
  followup: { stage: 5, say: ["No problem. I will WhatsApp you the syllabus.", "Can I call you Saturday at 11? Only because the ₹20,000 ends on 30 October, and registrations close on 11 November."], tip: "Change the day and time to suit them.",
    opts: [{ k: "yes", hint: "Agreed", to: "end_followup" }, { k: "no", hint: "“I will call you”", to: "followup_n" }, { k: "maybe", hint: "Different time", to: "followup_time" }] },
  followup_time: { stage: 5, say: ["Sure. What day works for you?", "Okay, I will call you then. Thanks, {name}!"],
    opts: [{ k: "next", hint: "Time agreed", to: "end_followup" }] },
  followup_n: { stage: 5, say: ["Sure, no problem. I will just send the details.", "Message me whenever you are ready. Thanks, {name}!"],
    opts: [{ k: "next", hint: "Call finished", to: "end_details" }] },

  exit_polite: { stage: 5, say: ["No problem at all, {name}. Thanks for your time.", "Have a good day!"],
    opts: [{ k: "next", hint: "Call finished", to: "end_lost" }] },
  exit_notfit: { stage: 5, say: ["Then honestly, {name}, this is not right for you right now.", "I prefer to tell you honestly. Thanks for your time!"],
    opts: [{ k: "next", hint: "Call finished", to: "end_lost" }] },
  exit_wrong: { stage: 0, say: ["Oh, sorry to disturb you. Have a good day!"],
    opts: [{ k: "next", hint: "Call finished", to: "end_wrong" }] },
  exit_dnc: { stage: 0, say: ["Understood. I will not call again.", "Sorry for the trouble. Take care."],
    opts: [{ k: "next", hint: "Call finished", to: "end_dnc" }] },

  end_won: { stage: 5, end: { tone: "good", label: "Enrolling", note: "Send the link within five minutes. Check in tomorrow.",
    msg: "Hi {name}, {me} from TechSimPlus here. Good speaking with you.\n\nHere is the Vector 2.0 enrolment page: " + SITE + "\n\nEarly-bird fee is ₹20,000 till 30 Oct. You can pay in 2 instalments: ₹6,000 to join, the rest within 15 days. 3-day no-questions-asked refund. Registrations close 11 Nov, and the batch starts 21 Nov.\n\nMessage me here if you need any help." } },
  end_followup: { stage: 5, end: { tone: "mid", label: "Follow-up booked", note: "Send this now. Put the follow-up in your calendar.",
    msg: "Hi {name}, {me} from TechSimPlus here. Good speaking with you. As discussed, here is Vector 2.0: " + SITE + "\n\nQuick recap: 3-month live Gen-AI cohort, 5 production projects deployed on AWS, 5 one-on-one mock interviews with real Gen-AI developers, a personal mentor, Demo Day with hiring partners. 2 weekday classes (morning 6:30–8:30 or evening 8–10) plus a weekend class, 10 to 4. Lifetime recordings.\n\nEarly-bird fee is ₹20,000 till 30 Oct (₹25,000 after). You can pay in 2 instalments: ₹6,000 to join, the rest within 15 days. 3-day no-questions-asked refund. Registrations close 11 Nov, and the batch starts 21 Nov.\n\nI will get back to you as we agreed. Message me here if anything comes up before that." } },
  end_callback: { stage: 0, end: { tone: "mid", label: "Call back later", note: "Send this so they recognise your number next time.",
    msg: "Hi {name}, {me} from TechSimPlus here. I called about Vector 2.0, our live Gen-AI developer cohort. I will call you at the time we agreed.\n\nDetails if you want a look first: " + SITE } },
  end_techcall: { stage: 1, end: { tone: "mid", label: "Tech team call", note: "Book the tech team call now. Pass on their questions.",
    msg: "Hi {name}, {me} from TechSimPlus here. Good speaking with you. I am setting up a call with our tech team for your Vector 2.0 questions, at the time we agreed.\n\nCourse details: " + SITE + "\n\nEarly-bird fee is ₹20,000 till 30 Oct, and you can pay in 2 instalments. Registrations close 11 Nov, and the batch starts 21 Nov.\n\nMessage me here if the time needs to change." } },
  end_details: { stage: 5, end: { tone: "mid", label: "Details only", note: "Send this once. Do not chase with calls unless they agreed to one.",
    msg: "Hi {name}, {me} from TechSimPlus here. Thanks for your time today. Here are the details of Vector 2.0, our live Gen-AI developer cohort: " + SITE + "\n\nRegistrations close 11 Nov, and the batch starts 21 Nov. Early-bird fee is ₹20,000 till 30 Oct, and you can pay in 2 instalments.\n\nNo rush. Message me here if you have any questions." } },
  end_noanswer: { stage: 0, end: { tone: "mid", label: "No answer", note: "Send this, then try once more at a different time of day.",
    msg: "Hi {name}, {me} from TechSimPlus here. I tried calling about your enquiry for Vector 2.0, our Gen-AI program. When is a good time for a quick 5-minute call?" } },
  end_lost: { stage: 5, end: { tone: "bad", label: "Not this time", note: "No message needed. Note the reason they gave. It will sharpen your next call." } },
  end_wrong: { stage: 0, end: { tone: "bad", label: "Wrong number", note: "Mark the number as wrong in your lead sheet." } },
  end_dnc: { stage: 0, end: { tone: "bad", label: "Do not call", note: "Mark this lead as do-not-call. No message, no second try." } }
};

const OBJECTIONS = [
  { g: "push", chip: "Not interested", say: "No problem. Just one question before I go. Are you thinking of moving into Gen-AI in your career?", exit: "exit_polite" },
  { g: "push", chip: "Where did you get my number?", say: "From the form on our site. You had enquired about Vector 2.0. If you do not want me to call, please tell me.", exit: "exit_dnc" },
  { g: "push", chip: "I never enquired", say: "Oh, sorry about that. Maybe someone typed your number by mistake. Are you interested in learning Gen-AI?", exit: "exit_dnc" },
  { g: "push", chip: "Just WhatsApp me", say: "Sure, I will. One quick question, so I send the right details. Are you looking to move into a Gen-AI role?", exit: "followup_n" },
  { g: "push", chip: "Is this a scam?", say: "Good question! Please check about us first. The instructor’s LinkedIn is public, and we have a YouTube channel. Plus there is a 3-day refund.", exit: "exit_polite" },
  { g: "push", chip: "Courses are useless", say: "Many people tell me that. Most courses are recorded videos that nobody finishes. This one is live, with deadlines, and a mentor checks your work. Can I tell you how it works?", exit: "exit_polite" },
  { g: "push", chip: "AI is just hype", say: "Maybe! But more and more jobs now ask for Gen-AI skills. This course helps you get those jobs.", exit: "exit_polite" },
  { g: "push", chip: "Already in another course", say: "Oh nice, which one? Is it live, with projects you deploy, and mock interviews? If yes, continue with it. If not, that is what we give you.", exit: "exit_polite" },
  { g: "push", chip: "Stop calling me", say: "Understood. I will not call again. Sorry for the trouble. Take care.", only: "end_dnc" },
  { g: "push", chip: "They got angry", say: "I am sorry, I did not mean to bother you. I will let you go. Have a good day.", tip: "Do not argue or explain. End the call calmly.", only: "end_lost" },
  { g: "push", chip: "No answer or call dropped", say: "Hi {name}, {me} from TechSimPlus. I will send you a WhatsApp message. Thank you!", tip: "Say this only if you reach voicemail. Otherwise just send the message.", only: "end_noanswer" },

  { g: "worry", chip: "What is TechSimPlus?", say: "We are a tech training company, based in Bhopal. We have trained over 12,000 students, in Python, full stack, AI and more. Vector 2.0 is our live Gen-AI course.", tip: "If they ask about placements: our site lists past students at TCS, Infosys, Wipro, Flipkart and Samsung. That is TechSimPlus overall, not a promise for Vector." },
  { g: "worry", chip: "Where are you based? Is it online?", say: "Our studio is in Bhopal. But Vector 2.0 is fully live online, so you can join from anywhere." },
  { g: "worry", chip: "Too expensive", say: "I understand, ₹20,000 is a big amount. But you get three months of live classes, five projects and five mock interviews. You can pay in two parts, ₹6,000 to join. And there is a 3-day refund. Does that help?" },
  { g: "worry", chip: "Can I pay in instalments?", say: "Yes. You can pay in two instalments. ₹6,000 to join the batch, and the rest within 15 days. And ₹20,000 is the early-bird price, till 30 October.", tip: "Do not promise a discount. For anything beyond the two instalments, ask the team first." },
  { g: "worry", chip: "Placement support? Will I get a job?", say: "Yes, there is placement support. The main focus is preparing you for Gen-AI developer roles, and helping you apply. Five mock interviews with real Gen-AI developers, and a Demo Day with hiring partners. Honestly, nobody can guarantee a job, but you will be ready for interviews." },
  { g: "worry", chip: "No Gen-AI experience", say: "This course is made for people like you. You just need Python. We start from the basics and go step by step." },
  { g: "worry", chip: "I do not know Python", say: "If you know any other language, you are fine. We give you recorded Python lectures covering everything you need. You finish them before the main classes start." },
  { g: "worry", chip: "No time, full-time job", say: "Most people in the batch have jobs. Weekdays, it is only two classes, morning or night, and you can switch between them. And everything is recorded. Which batch suits you?" },
  { g: "worry", chip: "What if I miss a class?", say: "No problem. You get the recording after every class, and it is yours for life." },
  { g: "worry", chip: "Can I switch batch?", say: "Yes. Both batches cover the same topic every day, with the same mentor. Switch between morning and evening whenever you need." },
  { g: "worry", chip: "Is there a certificate?", say: "Yes, you get a certificate from TechSimPlus Learnings." },
  { g: "worry", chip: "Can I see a demo class?", say: "We can share some class recordings from Vector 1.0. The same mentor teaches Vector 2.0, so you will see exactly how he teaches.", tip: "Get the recording link from the team and send it on WhatsApp." },
  { g: "worry", chip: "Are projects production level?", say: "Yes. Every project is production-level, and you learn to deploy it on AWS. You will also learn Docker and CI/CD pipelines." },
  { g: "worry", chip: "What is Gen-AI?", say: "Gen-AI is AI that creates things, like text, code or answers. ChatGPT is one example. Companies now hire developers who build apps on these AI models. That is what this course teaches you.", tip: "Keep it simple. Then link it to the work they do today." },
  { g: "worry", chip: "What is RAG?", say: "RAG means the AI first looks up your own documents, and then answers. So the answers are correct and up to date. You build a full RAG project in the course." },
  { g: "worry", chip: "What will I learn?", say: "There are eight parts. FastAPI first, then LLMs and LangChain, RAG, LangGraph workflows, and AI agents with MCP. Then cloud AI on AWS and Azure, and finally deploying and scaling for millions of users. I will WhatsApp you the full syllabus." },
  { g: "worry", chip: "Do you teach Azure?", say: "Yes. Everyone learns both AWS Bedrock and Azure AI. On Azure, you use Azure OpenAI, AI Search and Foundry. Then you pick AWS or Azure to deploy your final project.", tip: "If they ask which to pick: many IT services companies in India use Azure, many product companies and startups use AWS." },
  { g: "worry", chip: "What do you cover in cloud?", say: "You learn AWS Bedrock and Azure AI, and fine-tuning a model on your own data. Then you deploy your final project on AWS or Azure, with Docker, Kubernetes and CI/CD." },
  { g: "worry", chip: "Do you teach fine-tuning?", say: "Yes. You fine-tune an open-source model with LoRA and QLoRA, on a real task from your projects. You also learn when fine-tuning is better than RAG, and when it is not." },
  { g: "worry", chip: "Do you teach AI agents?", say: "Yes. You build AI agents with LangGraph, CrewAI and Microsoft Agent Framework, and connect them with MCP and A2A. You also learn how to keep agents safe." },
  { g: "worry", chip: "What are the five projects?", say: "One reads GST invoices. One answers compliance questions from RBI and SEBI circulars. One processes health insurance claims. One is a team of AI agents that plans a trip. And the biggest one is a platform built for 10 million requests a day." },
  { g: "worry", chip: "Do I need a GPU?", say: "No. A laptop with 8 GB RAM is enough, 16 GB is better, with 50 GB free space. For GPU work, we use free or low-cost online GPUs, and we share the setup." },
  { g: "worry", chip: "Will cloud cost me extra?", say: "A little, but we keep it low. Most work runs on your laptop. AWS and Azure free credits cover most of the cloud work, and we show you how to keep costs down." },
  { g: "worry", chip: "How many hours a week?", say: "About 16 hours of live classes, and 4 to 6 hours of building on your own. So plan for about 20 to 22 hours a week." },
  { g: "worry", chip: "Is it in Hindi?", say: "Classes are in English. If something is not clear, the mentor can explain it in Hindi." },
  { g: "worry", chip: "Technical question", say: "Good question. I want you to hear it from our tech team. Shall I set up a quick call with them?", tip: "Note the question and a time that suits them." },
  { g: "worry", chip: "YouTube is free", say: "True, for the basics. But YouTube will not check your code or take your mock interview. Has it made you ready for interviews?" },
  { g: "worry", chip: "Too basic for me", say: "The first few weeks might be revision. Later it is LangGraph, agentic AI, MCP servers, AWS Bedrock, and deploying with Docker and CI/CD. Have you done these in real projects?" },
  { g: "worry", chip: "150 is a big batch", say: "The batch has a maximum of 150 students. But your final project is reviewed one-on-one, and so are the five mock interviews. And you get a personal mentor for any doubt." },
  { g: "worry", chip: "Who is the instructor?", say: "Prateek Mishra. Senior Gen-AI developer at an MNC, with 8 years of experience, 20-plus production projects. He taught the first batch too. I will send you his LinkedIn." },
  { g: "worry", chip: "Need to ask family", say: "Of course. What will they ask you? Tell me, and I will give you the answer now." },
  { g: "worry", chip: "I will join next batch", say: "You can. But the ₹20,000 price ends on 30 October, and registrations for this batch close on 11 November. What will change for you by the next batch?" },
  { g: "worry", chip: "Will my company pay?", say: "Many people ask that. Let me check the invoice details with my team, and I will send them today." },
  { g: "worry", chip: "I do not know the answer", say: "Good question. I do not want to guess. Let me check with my team, and I will message you today." }
];
/*END*/

const WORD = { yes: "Yes", no: "No", maybe: "Maybe", next: "Next" };
const KEY = { yes: "1", no: "2", maybe: "3", next: "Enter" };
const LABEL = { open: "Right person", wrong_person: "Lead available", intro: "Has time", intro_maybe: "Okay with questions", frame: "Agreed to talk", q_curriculum: "Checked curriculum", curr_yes: "Wants tech team call", techcall: "Continued after booking tech call", ni_soft: "Thinking of Gen-AI", send_details: "Okay to check back", callback: "Gave callback time", q_work: "Working engineer", fresher: "Python good", q_python: "Comfortable with Python", python_no: "Will do pre-work", q_genai: "Tried Gen-AI", burned: "Past course was recorded", trust: "Open to hear more", q_scale: "Can answer scaling question", experienced: "Done it all in production", q_goal: "Wants Gen-AI role", goal_no: "Projects would help", goal_no2: "Okay to send details", pitch1: "Following the pitch", trust_brand: "Okay to continue", pitch2: "Projects interesting", pitch3: "Is what they want", diff: "Wants timings", pitch_no: "Worry answered", time: "Timings doable", time_no: "Recordings help", time_no2: "Can adjust", fee: "Fine with fee", fee_maybe: "Okay after refund", fee_no: "Instalments work", fee_no2: "Would join if fee was no issue", fee_only: "Okay to wait on payment options", close: "Send link now", think: "Ready after worry", followup: "Follow-up agreed" };
const BUILTIN = { flow: FLOW, start: "open", scriptId: null, version: null };   // the built-in script: the fallback
let ACTIVE = BUILTIN;   // the script being walked; see useWanted()
// Every script question that has a real choice, in script order. Each gets its own column in the Calls tab.
const QUESTIONS = Object.keys(FLOW).filter((k) => LABEL[k]).map((k) => ({ key: k, label: LABEL[k] }));
const RESULT_COLS = ["Call outcome", "Called at", "Call duration", "Answers", "Objections raised", "Notes", "Callback date", "Consent", "Consent date"];
const RESULT_KEYS = ["outcome", "at", "duration", "answers", "objections", "notes", "callback", "consent", "consentDate"];
const $ = (id) => document.getElementById(id);
// Lookup in a table of built-in ids. A step id such as "constructor" must not find Object.prototype.
const own = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const state = { node: "open", history: [], trail: [], objs: [], objection: null, started: null, elapsed: 0, timer: null, callId: null, practice: false };
let sheet = null;
let phoneCheck = null;   // ImportCheck result for the sheet: flags per lead and counts. Worked out on load, never saved.
let lastOutcome = null;  // the outcome just saved on the end card, for Undo. Cleared when the lead or call changes.
const CALLBACK_OUTCOMES = { end_callback: 1, end_followup: 1, end_noanswer: 1, end_techcall: 1 };   // these keep a callback date
function refreshPhoneFlags() { phoneCheck = sheet ? ImportCheck.checkPhones(sheet.rows.map((r) => r[sheet.cols.phone])) : null; }
/* Sheets saved before the callback column existed get it here, so the cell index is never undefined. */
function ensureResultCols(s) {
  RESULT_KEYS.forEach((key, i) => {
    if (s.cols[key] != null) return;
    s.header.push(RESULT_COLS[i]);
    s.cols[key] = s.header.length - 1;
  });
  s.rows.forEach((r) => { while (r.length < s.header.length) r.push(""); });
}

/*SHEET*/
function findCol(header, re, skip) { return header.findIndex((h, i) => i !== skip && re.test(h)); }
function ingest(aoa, fileName) {
  const rows = aoa.map((r) => Array.from(r, (c) => (c == null ? "" : c))).filter((r) => r.some((c) => String(c).trim() !== ""));
  if (rows.length < 2) return { error: "That sheet has no lead rows under the header row." };
  const header = rows.shift().map((h) => String(h).trim());
  let name = findCol(header, /^(full[ _]?name|name|lead[ _]?name|student[ _]?name|candidate)/i, -1);
  if (name < 0) name = findCol(header, /name/i, -1);
  let phone = findCol(header, /phone|mobile|whats|cell/i, name);
  if (phone < 0) phone = findCol(header, /contact|number/i, name);
  const guessed = name < 0 || phone < 0;
  if (name < 0) name = phone === 0 ? 1 : 0;
  if (phone < 0) phone = name === 0 ? 1 : 0;
  const cols = { name, phone };
  RESULT_KEYS.forEach((key, i) => {
    let c = header.findIndex((h) => h.toLowerCase() === RESULT_COLS[i].toLowerCase());
    if (c < 0) { header.push(RESULT_COLS[i]); c = header.length - 1; }
    cols[key] = c;
  });
  rows.forEach((r) => { while (r.length < header.length) r.push(""); });
  let idx = rows.findIndex((r) => String(r[cols.outcome]).trim() === "");
  if (idx < 0) idx = 0;
  return { fileName, header, rows, cols, idx, guessed };
}
function isCalled(s, i) { return String(s.rows[i][s.cols.outcome]).trim() !== ""; }
function calledCount(s) { return s.rows.filter((r, i) => isCalled(s, i)).length; }
function nextOpen(s) { for (let n = 1; n <= s.rows.length; n++) { const i = (s.idx + n) % s.rows.length; if (!isCalled(s, i)) return i; } return -1; }
function writeResult(s, st, label, when) {
  const r = s.rows[s.idx], c = s.cols;
  r[c.outcome] = label; r[c.at] = when;
  r[c.duration] = String(Math.floor(st.elapsed / 60)).padStart(2, "0") + ":" + String(st.elapsed % 60).padStart(2, "0");
  r[c.answers] = st.trail.map((t) => (own(LABEL, t.node) || t.node) + ": " + WORD[t.k]).join("; ");
  r[c.objections] = st.objs.join("; ");
}
function exportAoa(s) { return [s.header].concat(s.rows); }
/* Leads tab: the sheet plus the latest call's phone results. Filled at export time because the phone's
   call log answers after the outcome is tapped. A row with no record keeps what the file already had. */
const LEAD_EXTRA = ["Outcome code", "Answered", "Connected time (s)", "Session ID"];
function leadsAoa(s) {
  const header = s.header.slice();
  const at = LEAD_EXTRA.map((name) => {
    let c = header.findIndex((h) => String(h).toLowerCase() === name.toLowerCase());
    if (c < 0) { header.push(name); c = header.length - 1; }
    return c;
  });
  const rows = s.rows.map((r, i) => {
    const out = r.slice(); while (out.length < header.length) out.push("");
    const rec = CallRecords.latestFor(s.fileName, i);
    if (rec) {
      const vals = [rec.outcomeCode || "", rec.answered == null ? "" : (rec.answered ? "yes" : "no"),
        rec.connectedSeconds == null ? "" : rec.connectedSeconds, rec.sessionId || ""];
      at.forEach((c, j) => { out[c] = vals[j]; });
    }
    return out;
  });
  return [header].concat(rows);
}
/*ENDSHEET*/

function note(text) { $("sheet-msg").textContent = text || ""; $("gate-msg").textContent = text || ""; }
function persist() { return sheet ? Vault.set("sheet", sheet) : Vault.remove("sheet"); }   // IndexedDB, never localStorage
function leadName() { return sheet ? String(sheet.rows[sheet.idx][sheet.cols.name]).trim() : ""; }

function names() { return { me: $("me-name").value.trim(), name: $("lead-name").value.trim() }; }
function plain(text) { const n = names(); return text.replace(/\{name\}/g, n.name || "there").replace(/\{me\}/g, n.me || "your caller"); }
function fillInto(parent, text) {
  const n = names();
  text.split(/(\{name\}|\{me\})/).forEach((part) => {
    if (part === "{name}" || part === "{me}") {
      const v = part === "{name}" ? n.name : n.me;
      parent.appendChild(el("span", v ? "fill" : "fill blank", v || (part === "{name}" ? "lead's name" : "your name")));
    } else if (part) parent.appendChild(document.createTextNode(part));
  });
}

function tick() {
  const s = state.started ? Math.floor((Date.now() - state.started) / 1000) : state.elapsed;
  state.elapsed = s;
  $("clock").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}
function startClock() { if (state.timer) return; state.started = Date.now() - state.elapsed * 1000; state.timer = setInterval(tick, 1000); }
function stopClock() { tick(); clearInterval(state.timer); state.timer = null; state.started = null; }

function go(to, pick) {
  state.history.push({ node: state.node, trail: state.trail.length });
  if (pick && pick.k !== "next") state.trail.push(pick);
  state.node = to; state.objection = null;
  if (FLOW[to].end) {
    stopClock();
    if (state.practice) { render(); return; }   // practice: the end card shows and nothing is written
    const undo = { rowIndex: sheet ? sheet.idx : -1, sheetName: sheet ? sheet.fileName : "", code: to, row: null, callId: null, prevCall: null, sentBefore: 0 };
    if (sheet) {
      const when = new Date().toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
      undo.row = sheet.rows[sheet.idx].slice();
      writeResult(sheet, state, FLOW[to].end.label, when);
      if (!own(CALLBACK_OUTCOMES, to)) sheet.rows[sheet.idx][sheet.cols.callback] = "";
      persist();
    }
    const before = state.callId ? CallRecords.get(state.callId) : null;
    if (before) { undo.prevCall = JSON.parse(JSON.stringify(before)); undo.sentBefore = ((before.cloud && before.cloud.sent) || []).length; }
    finishRecord(FLOW[to].end.label, to);
    undo.callId = state.callId;
    lastOutcome = sheet ? undo : null;
  } else startClock();
  render();
}
/* Undo of the outcome just saved: the row goes back to how it was (notes typed since are kept), the call
   record goes back too, and the script returns to the question before. If the result already uploaded,
   the record keeps its upload history, so the next outcome is sent as a correction. */
function undoOutcome() {
  const u = lastOutcome;
  lastOutcome = null;
  if (!u || !sheet || sheet.fileName !== u.sheetName || sheet.idx !== u.rowIndex || !u.row) { render(); return; }
  // Notes, consent and consent date typed or set since the outcome are kept.
  const keepCols = [sheet.cols.notes, sheet.cols.consent, sheet.cols.consentDate];
  const kept = keepCols.map((c) => sheet.rows[u.rowIndex][c]);
  sheet.rows[u.rowIndex] = u.row.slice();
  keepCols.forEach((c, j) => { sheet.rows[u.rowIndex][c] = kept[j]; });
  persist();
  const cur = u.callId ? CallRecords.get(u.callId) : null;
  if (cur) {
    const added = (((cur.cloud && cur.cloud.sent) || []).slice(u.sentBefore));
    const withdrawn = !added.length || Cloud.cancel(added.map((x) => x.id));
    if (u.prevCall) {
      const restored = JSON.parse(JSON.stringify(u.prevCall));
      restored.cloud = withdrawn ? u.prevCall.cloud : cur.cloud;
      if (restored.cloud === undefined) delete restored.cloud;
      CallRecords.add(restored);
    } else if (withdrawn) CallRecords.remove(u.callId);
    else CallRecords.update(u.callId, { outcome: "", outcomeCode: "", saveStatus: "undone" });
  }
  logEntry("outcome-undone", { code: u.code, row: u.rowIndex + 2 });
  back();
  render();
  note("Outcome undone. Pick the right answer for this lead.");
}
/* Undo log, kept in the vault (IndexedDB). Entries carry no lead names or numbers. */
function logEntry(action, extra) {
  const old = Vault.get("log");
  const list = Array.isArray(old) ? old.slice(-499) : [];
  list.push(Object.assign({ at: Date.now(), action: action }, extra));
  Vault.set("log", list);
}

function back() {
  if (state.objection != null) { state.objection = null; render(); return; }
  if (!state.history.length) return;
  const h = state.history.pop(); state.node = h.node; state.trail.length = h.trail;
  if (state.history.length) startClock();
  render();
}
function resetCall() { stopClock(); state.callId = null; state.node = ACTIVE.start; state.history = []; state.trail = []; state.objs = []; state.objection = null; state.elapsed = 0; tick(); }
function restart() { lastOutcome = null; resetCall(); if (!sheet) $("lead-name").value = ""; render(); }
function loadLead(i) {
  if (state.practice) { note(leaveMessage()); return; }
  lastOutcome = null; sheet.idx = i; $("lead-name").value = leadName(); resetCall(); persist(); render(); window.scrollTo({ top: 0, behavior: "auto" }); }

function copyText(text, btn, target, idle) {
  const done = () => { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = idle; }, 1800); };
  const select = () => { const r = document.createRange(); r.selectNodeContents(target); const s = getSelection(); s.removeAllRanges(); s.addRange(r); btn.textContent = "Selected, now copy"; };
  try { navigator.clipboard.writeText(text).then(done, select); } catch (e) { select(); }
}

async function readSheet(file) {
  if (state.practice) { note(I18n.t("practice.blocked")); return; }
  const isCsv = /\.csv$/i.test(file.name);
  if (!isCsv && typeof XLSX === "undefined") { note("The spreadsheet reader did not load. Check your internet connection and reload the page."); return; }
  try {
    let aoa;
    if (isCsv) aoa = parseCsv(await file.text());   // CSV stays text, so 09876543210 keeps its 0
    else {
      const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array", raw: true, cellDates: true });
      aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: true });
    }
    const s = ingest(aoa, file.name);
    if (s.error) { note(s.error); return; }
    let numeric = 0;
    s.rows.forEach((r) => { const v = r[s.cols.phone]; if (typeof v === "number") { numeric++; r[s.cols.phone] = String(v); } });
    sheet = s;
    ensureResultCols(s);
    refreshPhoneFlags();
    const done = calledCount(s);
    note((s.guessed ? "No clear name or phone heading found, so this is a guess. " : "") + "Names from “" + s.header[s.cols.name] + "”, numbers from “" + s.header[s.cols.phone] + "”. " + s.rows.length + " leads loaded" + (done ? ", " + done + " already called." : ".") +
      (numeric ? " " + numeric + " phone numbers were stored as numbers in the file, so a leading 0 may be missing. Check them before calling." : "") + " " + ImportCheck.problemText(phoneCheck.counts));
    loadLead(s.idx);
  } catch (e) { note("Could not read that file. Use an .xlsx or .csv file with a header row."); }
}
async function downloadSheet() {
  if (typeof XLSX === "undefined") { note("The spreadsheet writer did not load. Check your internet connection and reload the page."); return; }
  const wb = XLSX.utils.book_new();
  // Leads must stay the first tab: uploading this file again reads the first tab as the lead list.
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(leadsAoa(sheet)), "Leads");
  const calls = CallRecords.all();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(CallRecords.toAoa(calls, QUESTIONS, OBJECTIONS.map((o) => o.chip))), "Calls");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const filename = sheet.fileName.replace(/\.[^.]+$/, "") + "-called.xlsx";
  note("Preparing " + filename + "…");
  try {
    let ns = null;
    if (window.claude && window.claude.use) { try { ns = await window.claude.use("downloads"); } catch (e) {} }
    if (ns) { await ns.save({ filename, data: new Blob([buf]) }); }
    else {
      const url = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
    note("Saved " + filename + ": " + calledCount(sheet) + " of " + sheet.rows.length + " leads called, " + calls.length + " call record(s) in the Calls tab.");
  } catch (e) { note(e && e.code === "declined" ? "Download cancelled. Your results are still here." : "Could not save the file from this view. Your results are still here."); }
}

function tool(id, text, fn, cls) { const b = el("button", cls || "plain", text); b.type = "button"; b.id = id; b.addEventListener("click", fn); return b; }

// Phones and tablets get "Call on this device" (a tel: link); laptops call through the paired phone.
const TOUCH = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

function renderSheet() {
  const bar = $("sheet-bar"), tools = $("sheet-tools");
  $("sheet-empty").hidden = !!sheet; bar.hidden = !sheet;
  $("sheet-load").hidden = !!sheet; tools.hidden = !sheet;
  bar.textContent = ""; tools.textContent = "";
  syncImportButton();
  if (!sheet) return;
  const r = sheet.rows[sheet.idx], c = sheet.cols, n = sheet.rows.length, done = calledCount(sheet);

  // Top bar: previous / the lead on screen / next, then how to call them.
  const arrow = (id, text, label, to, off) => {
    const b = tool(id, text, () => loadLead(to), "plain arrow");
    b.setAttribute("aria-label", label); b.title = label; b.disabled = off;
    return b;
  };
  bar.appendChild(arrow("lead-prev", "‹", "Previous lead (← key)", sheet.idx - 1, sheet.idx === 0));
  const who = el("div", "who");
  who.appendChild(el("span", "label", "Lead " + (sheet.idx + 1) + " of " + n));
  const name = leadName();
  who.appendChild(el("strong", "", name || "No name in this row"));
  const sub = el("div", "whosub");
  const phone = String(r[c.phone]).trim();
  sub.appendChild(el("span", "phone", phone || "no number"));
  const out = String(r[c.outcome]).trim();
  sub.appendChild(el("span", "whostate" + (out ? " done" : ""), out ? "Called: " + out : "Not called yet"));
  const flag = phoneCheck && phoneCheck.flags[sheet.idx];
  if (flag && flag.status !== "ok") sub.appendChild(el("span", "flag", "Number needs checking: " + flag.reason));
  const due = LeadList.validDate(r[c.callback]);
  if (due) sub.appendChild(el("span", "whostate", "Callback " + (due <= LeadList.todayIso() ? "due " : "on ") + due));
  who.appendChild(sub);
  bar.appendChild(who);
  const nx = arrow("lead-next", "›", "Next lead (→ key)", sheet.idx + 1, sheet.idx >= n - 1);
  nx.classList.add("next");
  bar.appendChild(nx);

  const calls = el("div", "calls");
  if (phone && TOUCH && !state.practice && TermsGate.allowed()) {
    const a = el("a", PhoneLink.isPaired() ? "plain" : "primary", "Call on this device");
    a.href = "tel:" + phone.replace(/[^\d+]/g, ""); a.id = "call-link"; calls.appendChild(a);
  }
  if (phone && PhoneLink.isPaired() && !state.practice) {
    const first = name.split(/\s+/)[0];
    const cb = tool("call-laptop", TOUCH ? I18n.t("btn.callPhone") : (first ? I18n.t("btn.call", { first: first }) : I18n.t("btn.callPlain")), callFromLaptop, "primary");
    cb.disabled = !(linkHealth === "ok" || linkHealth === "checking") || !TermsGate.allowed();
    cb.title = cb.disabled ? "The phone is not reachable. See the banner at the top of the page." : "Dial this lead on your paired phone (C)";
    if (!TOUCH) cb.appendChild(el("kbd", "btnkey", "C"));
    calls.appendChild(cb);
  }
  if (calls.childNodes.length) bar.appendChild(calls);

  // Sheet card: name, progress, and the download.
  const info = el("div", "sheetinfo");
  const top = el("div", "top");
  top.appendChild(el("p", "fname", sheet.fileName));
  top.appendChild(el("span", "hint", done + " of " + n + " called"));
  info.appendChild(top);
  const meter = el("div", "progress"); const fill = el("span"); fill.style.width = (n ? Math.round(done / n * 100) : 0) + "%"; meter.appendChild(fill);
  info.appendChild(meter);
  tools.appendChild(info);
  const actions = el("div", "actions");
  actions.appendChild(tool("sheet-save", I18n.t("btn.download"), downloadSheet, "primary"));
  const rm = tool("sheet-remove", "Remove sheet", () => {
    if (state.practice) { note(I18n.t("practice.blocked")); return; }
    if (rm.dataset.sure) { sheet = null; phoneCheck = null; lastOutcome = null; persist(); note("Sheet removed from this browser."); $("lead-name").value = ""; resetCall(); render(); }
    else { rm.dataset.sure = "1"; rm.textContent = "Tap again to remove"; }
  });
  actions.appendChild(rm);
  tools.appendChild(actions);
}

/* ---- Calls from the laptop, through the paired phone ---- */
let callView = null;      // { sessionId, phase, offhookWallMs, endWallMs, final, summary }
let watchToken = 0;
const CALL_FINAL = { answered: 1, not_answered: 1, failed: 1, ended_unknown: 1 };

function phaseLabel(p) {
  return { REQUESTED: "dialling", OFFHOOK: "line in use", ENDED: "ended", FAILED: "not connected" }[p] || p;
}
function fmtSecs(s) { return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }

function renderCallPanel() {
  const box = $("call-panel");
  if (!callView) { box.hidden = true; return; }
  box.hidden = false; box.textContent = "";
  const live = callView.phase === "REQUESTED" || callView.phase === "OFFHOOK";
  box.appendChild(el("span", "label", live ? "On the phone" : "Last laptop call"));
  let line;
  if (callView.phase === "OFFHOOK" && callView.offhookWallMs) {
    const secs = Math.max(0, Math.floor((Date.now() - callView.offhookWallMs) / 1000));
    line = "Line in use for " + fmtSecs(secs) + ". This is not the answer time: the phone's call log gives that after the call.";
  } else if (live) line = "Dialling…";
  else line = callView.summary || "Call finished, checking the call log…";
  box.appendChild(el("p", "heard", line));
  if (live) box.appendChild(tool("call-hangup", "Hang up on the phone", hangupCall, "plain"));
}

function setCallSummary(sessionId, text) {
  if (callView && callView.sessionId === sessionId) { callView.final = true; callView.summary = text; }
  renderCallPanel();
}

function finishCall(sessionId, patch, summary) {
  CallRecords.update(sessionId, patch);
  cloudSync(sessionId);
  setCallSummary(sessionId, summary);
  note(summary);
}

async function callFromLaptop() {
  if (!sheet) return;
  if (state.practice) return;
  if (!TermsGate.allowed()) { note(I18n.t("call.blockedTerms")); return; }
  if (callView && (callView.phase === "REQUESTED" || callView.phase === "OFFHOOK")) { note("A call is already in progress."); return; }
  const r = sheet.rows[sheet.idx];
  const raw = String(r[sheet.cols.phone]).trim();
  const number = PhoneLink.toE164(raw);
  if (!number) { note("This number cannot be dialled as it is. Check it, or add the country code, for example +91."); return; }
  note("Dialling " + number + " through the phone…");
  let res;
  try { res = await phone("dial", { number: number }); }
  catch (e) { note("Could not dial: " + e.message); return; }
  if (!res.ok) { note("Could not dial: " + res.error); return; }
  CallRecords.add({
    sessionId: res.session, source: "laptop", sheetName: sheet.fileName, leadName: leadName(), phone: raw, phoneE164: number, rowIndex: sheet.idx,
    dialWallMs: res.dialWallMs, offhookWallMs: 0, endWallMs: 0, connectedSeconds: null, answered: null,
    detection: "", callStatus: "dialling", outcome: "", objections: "",
    notes: String(r[sheet.cols.notes] || ""), saveStatus: "awaiting-outcome", updatedAt: Date.now(),
  });
  state.callId = res.session;
  callView = { sessionId: res.session, phase: "REQUESTED", offhookWallMs: 0, endWallMs: 0, final: false, summary: "" };
  renderCallPanel();
  watchCall(res.session);
}

function watchCall(sessionId) {
  const token = ++watchToken;
  let fails = 0;
  const step = async () => {
    if (token !== watchToken) return;
    try {
      const st = await phone("status", { session: sessionId });
      fails = 0;
      if (!st.found) { finishCall(sessionId, { callStatus: "ended_unknown", detection: "approximate" }, "Call status is no longer on the phone; connected time unknown."); return; }
      callView = { sessionId: sessionId, phase: st.phase, offhookWallMs: st.offhookWallMs, endWallMs: st.endWallMs, final: false, summary: "" };
      CallRecords.update(sessionId, { offhookWallMs: st.offhookWallMs, endWallMs: st.endWallMs, callStatus: phaseLabel(st.phase) });
      renderCallPanel();
      if (st.phase === "ENDED" || st.phase === "FAILED") { readResult(sessionId, token, st.phase === "FAILED"); return; }
    } catch (e) {
      fails++;
      if (fails >= 720) { finishCall(sessionId, { callStatus: "ended_unknown", detection: "approximate" }, "Lost contact with the phone for an hour. Connected time unknown."); return; }
      if (fails === 30) note("Still waiting for the phone to reconnect. The call will settle when it does.");
      else if (fails < 30) note("Lost contact with the phone, retrying: " + e.message);
      setTimeout(step, fails >= 30 ? 5000 : 1000);
      return;
    }
    setTimeout(step, 1000);
  };
  step();
}

async function readResult(sessionId, token, failed) {
  if (failed) {
    finishCall(sessionId, { callStatus: "failed", answered: false, connectedSeconds: 0, detection: "phone" }, "The call did not start on the phone.");
    return;
  }
  for (let i = 0; i < 12; i++) {
    if (token !== watchToken) return;
    try {
      const r = await phone("result", { session: sessionId });
      if (!r.pending) {
        if (r.connectedSeconds == null) {
          finishCall(sessionId, { callStatus: "ended_unknown", detection: "approximate" }, "Call ended. Connected time not available: " + (r.reason || "unknown") + ".");
        } else if (r.answered) {
          finishCall(sessionId, { connectedSeconds: r.connectedSeconds, answered: true, detection: "call-log", callStatus: "answered" },
            "Answered. Connected for " + r.connectedSeconds + " s (from the phone's call log).");
        } else {
          finishCall(sessionId, { connectedSeconds: 0, answered: false, detection: "call-log", callStatus: "not_answered" },
            "Not answered (no connected time in the call log).");
        }
        return;
      }
    } catch (e) { note("Could not read the call log yet: " + e.message); }
    await new Promise((res) => setTimeout(res, 2500));
  }
  finishCall(sessionId, { callStatus: "ended_unknown", detection: "approximate" }, "Call ended. The call log did not update in time; connected time unknown.");
}

async function hangupCall() {
  try {
    const r = await phone("hangup");
    note(r.ok ? "Hang up sent to the phone." : "Hang up failed: " + r.error);
  } catch (e) { note("Could not hang up: " + e.message); }
}

/* Called when an outcome button reaches an end card. Laptop calls already have a record; a call made
   any other way gets one now ("manual"), so the Calls tab holds every call. Going back and picking a
   different outcome updates the same record. */
function finishRecord(label, code) {
  const answers = {};
  state.trail.forEach((t) => { answers[t.node] = WORD[t.k]; });   // a question asked twice keeps the last answer
  const top = state.trail.reduce((m, t) => Math.max(m, FLOW[t.node].stage), -1);
  const patch = {
    outcome: label, outcomeCode: code, outcomeAtMs: Date.now(),
    answers: answers, path: state.trail.map((t) => t.node + "=" + t.k).join(" > "),
    stageReached: top < 0 ? "" : STAGES[top], scriptSeconds: state.elapsed,
    objections: state.objs.join("; "), objectionList: state.objs.slice(),
    notes: sheet ? String(sheet.rows[sheet.idx][sheet.cols.notes] || "") : "", saveStatus: "saved",
    scriptId: ACTIVE.scriptId, scriptVersion: ACTIVE.version,   // the script this call was walked on
  };
  if (state.callId && CallRecords.get(state.callId)) { CallRecords.update(state.callId, patch); cloudSync(state.callId); return; }
  const id = (crypto.randomUUID && crypto.randomUUID()) || ("m-" + Date.now() + "-" + Math.random().toString(16).slice(2));
  const phone = sheet ? String(sheet.rows[sheet.idx][sheet.cols.phone]).trim() : "";
  CallRecords.add(Object.assign({
    sessionId: id, source: "manual", sheetName: sheet ? sheet.fileName : null, rowIndex: sheet ? sheet.idx : null,
    leadName: $("lead-name").value.trim(), phone: phone, phoneE164: phone ? (PhoneLink.toE164(phone) || "") : "",
    dialWallMs: 0, offhookWallMs: 0, endWallMs: 0, connectedSeconds: null, answered: null,
    detection: "", callStatus: "", updatedAt: Date.now(),
  }, patch));
  state.callId = id;
  cloudSync(id);
}

/* ---- The script in use ----
   The built-in script is the fallback. A rep's published script (Cloud.publishedScript, adapted by
   js/script-adapter.js) replaces it only while the page is idle: no call live, no step taken, no objection
   open. The script in use is ACTIVE, in memory only, never in localStorage. */
let wanted = BUILTIN;
let scriptFetch = 0;
function idleForScript() {
  const live = callView && (callView.phase === "REQUESTED" || callView.phase === "OFFHOOK");
  return !live && !state.practice && !state.history.length && state.objection == null && !state.objs.length;
}
function useWanted() {
  if (ACTIVE === wanted || !idleForScript()) return;
  ACTIVE = wanted; FLOW = ACTIVE.flow; state.node = ACTIVE.start; state.trail = [];
}
async function loadPublishedScript() {
  const mine = ++scriptFetch;
  const got = await Cloud.publishedScript();   // null: cloud off, signed out, nothing published, or a read error
  if (mine !== scriptFetch) return;            // a later check has started, and its answer counts
  const flow = got ? ScriptAdapter.adaptSteps(got.steps) : null;
  if (got && !flow) note("This published script cannot be shown in the call page, so the built-in script is in use.");
  wanted = flow ? { flow: flow, start: ScriptAdapter.startStepId(got.steps), scriptId: got.scriptId, version: got.version } : BUILTIN;
  useWanted();
  render();
}

/* Loss reasons the rep can pick on a "Not this time" call. The codes match call_outcomes.loss_reason. */
const LOSS_REASONS = [
  ["price", "Price"], ["timing", "Timing"], ["already_enrolled", "Already enrolled"],
  ["no_need", "No need"], ["wrong_person", "Wrong person"], ["other", "Other"],
];
function setLossReason(code) {
  if (!state.callId || !CallRecords.get(state.callId)) return;
  CallRecords.update(state.callId, { lossReason: code });
  cloudSync(state.callId);
  render();
}

/* ---- Cloud sync (js/cloud.js) ----
   A call is uploaded once it is settled: the outcome is tapped and, for laptop calls, the phone has
   reported the result (or two minutes have passed). A later change to an uploaded call is sent as a
   correction row that points at the earlier one, so the cloud history is never rewritten. */
const CLOUD_OUTCOME = {
  end_won: "won", end_followup: "interested", end_techcall: "interested", end_callback: "callback", end_details: "other",
  end_noanswer: "no_answer", end_lost: "not_interested", end_wrong: "other", end_dnc: "not_interested",
};

function cloudRow(r) {
  const objs = r.objectionList || [];
  const dialMs = r.dialWallMs || (r.outcomeAtMs ? r.outcomeAtMs - (r.scriptSeconds || 0) * 1000 : 0);
  return {
    script_id: r.scriptId == null ? null : String(r.scriptId).slice(0, 80),
    script_version: r.scriptVersion == null ? null : Number(r.scriptVersion),
    script_step: (r.outcomeCode || "").slice(0, 80) || null,   // the end card reached, e.g. end_details
    stage_reached: r.stageReached ? String(r.stageReached).slice(0, 40) : null,   // the furthest stage, e.g. Pitch
    loss_reason: r.lossReason || null,
    objection: objs.length ? String(objs[objs.length - 1]).slice(0, 80) : null,
    outcome: own(CLOUD_OUTCOME, r.outcomeCode) || "other",
    dialled_at: dialMs ? new Date(dialMs).toISOString() : null,
    connected_seconds: r.connectedSeconds == null ? null : Math.max(0, Math.round(r.connectedSeconds)),
    phone_session_id: r.source === "laptop" ? String(r.sessionId).slice(0, 80) : null,
  };
}

function cloudSync(sessionId) {
  if (!Cloud.enabled || !Cloud.hasSeat()) return;
  const r = CallRecords.get(sessionId);
  if (!r || r.saveStatus !== "saved" || !r.outcomeCode || (r.outcomeAtMs || 0) < Cloud.since()) return;
  const settled = r.source !== "laptop" || CALL_FINAL[r.callStatus] || Date.now() - (r.outcomeAtMs || 0) > 120000;
  if (!settled) return;
  const row = cloudRow(r);
  const sig = JSON.stringify(row);
  const sent = (r.cloud && r.cloud.sent) || [];
  // Saved before the script was recorded and already uploaded: not sent again under a new label.
  if (r.scriptId === undefined && sent.length) return;
  if (sent.length && sent[sent.length - 1].sig === sig) return;   // nothing new to send
  const id = crypto.randomUUID();
  const full = Object.assign({ id: id, client_record_id: (sent.length ? r.sessionId + "~" + (sent.length + 1) : r.sessionId).slice(0, 80),
    corrects_id: sent.length ? sent[sent.length - 1].id : null }, row);
  // Marked as sent first: queueing announces a change, and that must not offer this call again.
  CallRecords.update(sessionId, { cloud: { sent: sent.concat([{ id: id, sig: sig }]) } });
  if (!Cloud.enqueue(full)) CallRecords.update(sessionId, { cloud: { sent: sent } });
}

/* Laptop calls whose outcome was tapped before the phone's result came in. */
function cloudSweep() {
  if (!Cloud.enabled || !Cloud.hasSeat()) return;
  CallRecords.all().forEach((r) => { if (r.saveStatus === "saved") cloudSync(r.sessionId); });
}

const CLOUD_LABEL = {
  off: "Results stay in this browser only",
  starting: "Starting sync…",
  signed_out: "Signed out, not syncing",
  link_sent: "Check your email to sign in",
  no_seat: "No active seat, not syncing",
  ready: "Synced",
  offline: "Offline",
  error: "Sync error",
};
/* Header status, always shown. Off means no cloud on this site: results stay in this browser. */
function renderCloud(c) {
  const pill = $("cloud-panel");
  pill.hidden = false;
  const waiting = c.pending > 0;
  const label = CLOUD_LABEL[c.status] || "Sync status unknown";
  let summary = label;
  if (c.status === "ready" && waiting) summary = c.pending + " to sync";
  else if ((c.status === "offline" || c.status === "error") && waiting) summary = label + ", " + c.pending + " waiting";
  pill.dataset.sync = c.status === "off" ? "local" : c.status === "ready" ? (waiting ? "wait" : "ok") : "off";
  $("cloud-summary").textContent = summary;
  $("cloud-signout").hidden = !(c.enabled && c.email);
  const lines = [];
  if (c.status === "off") lines.push("Results stay in this browser only. Cloud sync is not set up on this site.");
  else {
    if (c.email) lines.push("Signed in as " + c.email + (c.seatLabel ? " (" + c.seatLabel + ")" : "") + ".");
    if (c.status === "offline") lines.push("No connection to the Vector cloud. Results stay in this browser until it is back.");
    if (c.status === "error") lines.push("Could not reach the Vector cloud" + (c.lastError ? ": " + c.lastError : "") + ".");
    if (c.status === "no_seat") lines.push("This account has no active seat, so results are not uploaded.");
    lines.push(waiting ? c.pending + " call result(s) waiting to upload; they upload automatically when the connection is back." : "All call results are uploaded.");
  }
  if (c.failed) lines.push(c.failed + " could not be uploaded.");
  lines.push("Lead names and numbers never leave this browser.");
  $("cloud-status").textContent = lines.join(" ");
}

function renderSignin(c) {
  const msg = $("signin-msg"), actions = $("signin-actions");
  actions.textContent = "";
  $("signin-form").hidden = !(c.status === "signed_out" || c.status === "link_sent" || c.status === "error");
  if (c.status === "starting") { $("signin-title").textContent = "Signing in…"; $("signin-text").textContent = "Checking your account."; msg.textContent = ""; }
  else if (c.status === "link_sent") { $("signin-title").textContent = "Check your email"; $("signin-text").textContent = "We sent a sign-in link. Open it on this computer, in this browser. You can close this tab; the link opens Vector signed in."; }
  else if (c.status === "no_seat") {
    $("signin-title").textContent = "No active seat";
    $("signin-text").textContent = "You're signed in as " + c.email + ", but this account has no active seat. Ask your institute admin to assign you one, then try again.";
    actions.appendChild(tool("signin-retry", "Try again", () => Cloud.retry(), "primary"));
    actions.appendChild(tool("signin-out", "Sign out", () => Cloud.signOut(), "plain"));
  } else if (c.status === "error") {
    $("signin-title").textContent = "Sign in";
    $("signin-text").textContent = "Use the work email your institute invited. Sign in with your password, or leave it empty and we'll email you a sign-in link.";
    msg.textContent = "Could not reach the Vector cloud: " + c.lastError;
    actions.appendChild(tool("signin-retry", "Try again", () => Cloud.retry(), "plain"));
  } else { $("signin-title").textContent = "Sign in"; $("signin-text").textContent = "Use the work email your institute invited. Sign in with your password, or leave it empty and we'll email you a sign-in link."; }
}

/* One button: with a password it signs in at once; with the password empty it emails a sign-in link. */
function syncSigninButton() {
  $("signin-send").textContent = $("signin-password").value ? "Sign in" : "Email me a sign-in link";
}
async function sendSigninLink() {
  const btn = $("signin-send"), pw = $("signin-password");
  btn.disabled = true;
  $("signin-msg").textContent = "";
  try {
    if (pw.value) { await Cloud.signInPassword($("signin-email").value, pw.value); pw.value = ""; syncSigninButton(); }
    else await Cloud.sendLink($("signin-email").value);
  }
  catch (e) { $("signin-msg").textContent = e.message; }
  finally { btn.disabled = false; }
}

let appReady = false;   // set once the sheet, call records and link key have loaded
function refreshLinkPanel() {
  if (!appReady) return;
  const paired = PhoneLink.isPaired();
  const c = Cloud.info();
  // With the cloud set up, signing in comes first; then pairing; then the workspace.
  const needSignin = c.enabled && !(c.status === "ready" || c.status === "offline");
  $("signin").hidden = !needSignin;
  if (needSignin) renderSignin(c);
  $("gate").hidden = needSignin || paired; $("app").hidden = needSignin || !paired;
  renderCloud(c);
  if (paired) { stopScan(); $("cert-box").hidden = true; $("gate-msg").textContent = ""; }
  renderHealth();
  Onboarding.maybeShow();
}

/* ---- Phone connection: checked every 15 s while this tab is visible, and on every request ---- */
let linkHealth = "checking";   // checking | ok | offline | unpaired | clock
let linkError = "";

async function phone(op, extra) {
  try {
    const r = await PhoneLink.request(op, extra);
    setHealth("ok");
    return r;
  } catch (e) {
    setHealth(e.unpaired ? "unpaired" : e.clock ? "clock" : e.unreachable ? "offline" : linkHealth, e.message);
    throw e;
  }
}

function setHealth(h, msg) {
  const was = linkHealth;
  linkHealth = h; linkError = msg || "";
  renderHealth();
  if (was !== h) renderSheet();   // the Call button follows the connection
}

async function checkPhone() {
  if (!PhoneLink.isPaired() || document.hidden) return;
  try { await phone("ping"); } catch (e) {}
}

function renderHealth() {
  const host = PhoneLink.host();
  $("link-panel").dataset.health = linkHealth;
  $("link-summary").textContent = { checking: "Checking phone…", ok: "Phone connected", offline: "Phone offline", unpaired: "Phone needs pairing", clock: "Clock mismatch" }[linkHealth];
  $("link-status").textContent = (host ? "Paired with the phone at " + host + ". " : "") +
    (linkHealth === "ok" ? "Calls from this page go through the phone. Each call is recorded in the Calls tab of the results download." : "");
  const banner = $("link-banner"), tools = $("link-banner-tools");
  tools.textContent = "";
  banner.hidden = linkHealth === "ok" || linkHealth === "checking" || !PhoneLink.isPaired();
  if (banner.hidden) return;
  const pairAgain = tool("link-repair", "Pair again", () => { forgetPhone(); note("Show the pairing QR on the phone, then scan it here."); }, linkHealth === "unpaired" ? "primary" : "plain");
  const retry = tool("link-retry", "Try again", checkPhone, "primary");
  if (linkHealth === "offline") {
    $("link-banner-title").textContent = "Can't reach your phone";
    $("link-banner-text").textContent = "Check that the phone is on the same Wi-Fi as this laptop and that Vector Companion is running (its notification is showing). " +
      "If the phone's Wi-Fi address changed, open the certificate page once, accept the warning, then pair again. A phone restart on the same Wi-Fi does not need this.";
    tools.appendChild(retry);
    const cert = el("a", "plain", "Open certificate page"); cert.href = PhoneLink.certUrl(host); cert.target = "_blank"; cert.rel = "noopener";
    tools.appendChild(cert);
    tools.appendChild(pairAgain);
  } else if (linkHealth === "unpaired") {
    $("link-banner-title").textContent = "The phone no longer recognises this browser";
    $("link-banner-text").textContent = "This happens after Forget this laptop on the phone, or when another browser pairs with it: the phone keeps one laptop at a time. Pair again to continue.";
    tools.appendChild(pairAgain);
  } else {
    $("link-banner-title").textContent = "This laptop's clock and the phone's clock disagree";
    $("link-banner-text").textContent = "They differ by more than a minute, so the phone refuses requests. Set both to automatic date and time, then try again.";
    tools.appendChild(retry);
  }
}

let pendingPair = null;      // { host, code } kept while the certificate step is open
let scanStream = null;
let scanTimer = null;

async function pairWith(host, code) {
  pendingPair = { host, code };
  try {
    await PhoneLink.pair(host, code);
    pendingPair = null;
    linkHealth = "ok"; linkError = "";
    $("cert-box").hidden = true;
    note("Paired with the phone.");
  } catch (e) {
    if (e.unreachable) {
      $("cert-open").href = PhoneLink.certUrl(e.host);
      $("cert-hint").textContent = "The browser has not accepted the phone's certificate yet. Step 1 opens the phone's page: accept the warning there, then come back and tap step 2.";
      $("cert-box").hidden = false;
    } else {
      note("Pairing failed: " + e.message);
    }
  } finally { refreshLinkPanel(); render(); }
}

async function pairFromUi() {
  $("link-pair").disabled = true;
  try { await pairWith($("link-host").value, $("link-code").value); $("link-code").value = ""; }
  finally { $("link-pair").disabled = false; }
}

/* Reads the phone's pairing QR code with the laptop camera, then pairs. */
async function startScan() {
  if (scanStream) return;
  if (typeof jsQR !== "function") { note("The QR reader did not load. Check the internet connection, or enter the code by hand."); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { note("This browser cannot use the camera here. Enter the code by hand."); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }); }
  catch (e) { note("Camera not available (" + (e.name || "error") + "). Enter the code by hand."); return; }
  scanStream = stream;
  const v = $("scan-video");
  v.srcObject = stream;
  $("scan-box").hidden = false;
  try { await v.play(); } catch (e) {}
  const canvas = document.createElement("canvas");
  const cx = canvas.getContext("2d", { willReadFrequently: true });
  scanTimer = setInterval(() => {
    if (v.readyState < 2 || !v.videoWidth) return;
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    cx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const img = cx.getImageData(0, 0, canvas.width, canvas.height);
    const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
    const found = hit && hit.data ? PhoneLink.parseQr(hit.data) : null;
    if (found) { stopScan(); pairWith(found.host, found.code); }
  }, 250);
}

function stopScan() {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
  scanStream = null;
  $("scan-video").srcObject = null;
  $("scan-box").hidden = true;
}

function forgetPhone() {
  PhoneLink.forget();
  callView = null;
  refreshLinkPanel(); renderCallPanel(); render();
  note("This browser is no longer paired with the phone.");
}

/* After a reload: pick up a laptop call that was still open for the lead on screen. */
function resumeLastCall() {
  if (!PhoneLink.isPaired() || !sheet) return;
  const open = CallRecords.all()
    .filter((r) => r.saveStatus === "awaiting-outcome" && !CALL_FINAL[r.callStatus] && r.rowIndex === sheet.idx)
    .sort((a, b) => b.dialWallMs - a.dialWallMs)[0];
  if (!open) return;
  state.callId = open.sessionId;
  callView = { sessionId: open.sessionId, phase: "REQUESTED", offhookWallMs: 0, endWallMs: 0, final: false, summary: "" };
  renderCallPanel();
  watchCall(open.sessionId);
}

function parseCsv(text) {
  const src = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* Note templates: a dropdown that puts the chosen text at the cursor of the notes box. */
function templatePicker(ta, saveNotes) {
  const wrap = el("div", "tplrow");
  const sel = el("select", "tpl"); sel.id = "note-template"; sel.setAttribute("aria-label", "Insert a note template");
  sel.appendChild(new Option("Insert a note template…", ""));
  NOTE_TEMPLATES.forEach((t) => sel.appendChild(new Option(t.label, t.id)));
  sel.addEventListener("change", () => {
    const t = NOTE_TEMPLATES.find((x) => x.id === sel.value);
    sel.value = "";
    if (!t) return;
    const text = ta.value;
    const start = ta.selectionStart == null ? text.length : ta.selectionStart;
    const end = ta.selectionEnd == null ? text.length : ta.selectionEnd;
    const gap = start > 0 && !/\s$/.test(text.slice(0, start)) ? " " : "";
    const insert = gap + t.text;
    ta.value = text.slice(0, start) + insert + text.slice(end);
    ta.setSelectionRange(start + insert.length, start + insert.length);
    ta.focus();
    saveNotes(ta.value);
  });
  wrap.appendChild(sel);
  return wrap;
}

/* Callback date for this lead. Due dates show first in the daily queue. */
function callbackField() {
  const wrap = el("label", "field cbfield");
  wrap.appendChild(el("span", "label", "Call back on"));
  const cb = el("input"); cb.type = "date"; cb.id = "lead-callback";
  cb.value = LeadList.validDate(sheet.rows[sheet.idx][sheet.cols.callback]);
  cb.addEventListener("change", () => {
    sheet.rows[sheet.idx][sheet.cols.callback] = LeadList.validDate(cb.value);
    persist(); renderSheet(); renderLeads();
    requestCallbackReminder(LeadList.validDate(cb.value));
  });
  wrap.appendChild(cb);
  wrap.appendChild(el("span", "hint", "Shows at the top of the daily queue on this date."));
  return wrap;
}

/* Leave-lead rule: no moving to another lead during a live call or part-way through the script. */
function leaveBlocked() {
  const live = callView && (callView.phase === "REQUESTED" || callView.phase === "OFFHOOK");
  const midScript = state.history.length > 0 && !FLOW[state.node].end;
  return !!(live || midScript || state.practice);
}
function leaveMessage() {
  return state.practice ? I18n.t("practice.blocked") : "Finish or restart this call before moving to another lead.";
}
function goToLead(i) {
  if (leaveBlocked()) { note(leaveMessage()); return; }
  note("");
  loadLead(i);
}
function leadRow(i) {
  const row = sheet.rows[i];
  const li = el("li");
  const b = el("button", "leadrow" + (i === sheet.idx ? " current" : "")); b.type = "button";
  if (i === sheet.idx) b.setAttribute("aria-current", "true");
  b.appendChild(el("strong", "", String(row[sheet.cols.name]).trim() || "No name in this row"));
  b.appendChild(el("span", "phone", String(row[sheet.cols.phone]).trim() || "no number"));
  const st = LeadList.statusOf(row, sheet.cols, LeadList.todayIso());
  b.appendChild(el("span", "leadstate " + st.kind, st.label));
  b.addEventListener("click", () => goToLead(i));
  li.appendChild(b);
  return li;
}
/* Leads panel: search by name or number, and a filter. "Today's queue" is the default: due callbacks, then no-answer retries, then new leads. */
function renderLeads() {
  const panel = $("leads-panel");
  panel.hidden = !sheet;
  if (!sheet) return;
  const list = $("leads-list");
  list.textContent = "";
  const status = $("lead-filter").value;
  const idxs = LeadList.filterLeads(sheet.rows, sheet.cols, { query: $("lead-search").value, status: status }, LeadList.todayIso());
  const shown = idxs.slice(0, 60);
  $("leads-count").textContent = idxs.length + " of " + sheet.rows.length + " leads" +
    (idxs.length > shown.length ? ". Showing the first " + shown.length + ", narrow the search to see more" : "") +
    (status === "queue" ? ". Due callbacks first, then no-answer retries, then new leads." : "");
  shown.forEach((i) => list.appendChild(leadRow(i)));
  if (!shown.length) list.appendChild(el("li", "hint", "No leads match."));
}

function render() {
  useWanted();
  const node = FLOW[state.node];
  renderSheet();
  renderPractice();
  const rail = $("rail"); rail.textContent = "";
  STAGES.forEach((s, i) => { const li = el("li", i < node.stage ? "done" : i === node.stage ? "now" : "", s); if (i === node.stage) li.setAttribute("aria-current", "step"); rail.appendChild(li); });

  const stage = $("stage"); stage.textContent = "";
  const card = el("div", "card");
  const mk = (k, word, hint, fn) => {
    const b = el("button", "ans " + k); b.type = "button"; b.id = "ans-" + k;
    const t = el("b", "", word); t.appendChild(el("kbd", "", KEY[k])); b.appendChild(t);
    b.appendChild(el("span", "", hint)); b.addEventListener("click", fn); return b;
  };

  if (state.objection != null) {
    const o = OBJECTIONS[state.objection];
    card.appendChild(el("span", "label", "They said"));
    card.appendChild(el("p", "heard", "“" + o.chip + "”"));
    card.appendChild(el("span", "label", "Read this aloud"));
    const say = el("div", "say"); const p = el("p"); fillInto(p, o.say); say.appendChild(p); card.appendChild(say);
    if (o.tip) card.appendChild(el("p", "tip", o.tip));
    const resume = () => { state.objection = null; render(); };
    const wrap = el("div", "answers" + (o.exit ? " two" : " one"));
    if (o.only) wrap.appendChild(mk("next", "Next", "Call finished", () => go(o.only)));
    else if (o.exit) {
      card.appendChild(el("p", "label ask", "How did they respond?"));
      wrap.appendChild(mk("yes", "Yes", "They are okay, back to the script", resume));
      wrap.appendChild(mk("no", "No", "Still a no, close the call", () => go(o.exit)));
    } else wrap.appendChild(mk("next", "Back to the script", "Returns to the line you were on", resume));
    card.appendChild(wrap);
  } else if (node.end) {
    const e = node.end;
    card.appendChild(el("span", "outcome " + e.tone, "Call ended: " + e.label));
    card.appendChild(el("p", "heard", e.note));
    const row = el("div", "tools");
    if (state.node === "end_lost" && state.callId && CallRecords.get(state.callId)) {
      card.appendChild(el("span", "label", "Why did they say no? Pick one, it helps the next call"));
      const current = CallRecords.get(state.callId).lossReason;
      const reasons = el("div", "tools");
      LOSS_REASONS.forEach(([code, label]) => {
        reasons.appendChild(tool("loss-" + code, label, () => setLossReason(code), current === code ? "primary" : "plain"));
      });
      card.appendChild(reasons);
    }
    if (e.msg) {
      card.appendChild(el("span", "label", "WhatsApp message to send"));
      const text = plain(e.msg);
      const pre = el("pre", "msg", text); card.appendChild(pre);
      const c = tool("copy-msg", I18n.t("btn.copy"), () => copyText(text, c, pre, I18n.t("btn.copy"))); row.appendChild(c);
    }
    if (sheet && !state.practice) {
      const r = sheet.rows[sheet.idx], col = sheet.cols.notes;
      const lab = el("label", "notes"); lab.appendChild(el("span", "label", "Notes for this lead, saved to the sheet"));
      const ta = el("textarea"); ta.id = "lead-notes"; ta.rows = 2; ta.value = String(r[col]); ta.placeholder = "Follow-up day and time, the reason they gave, anything to remember";
      const saveNotes = (text) => { r[col] = text; persist(); if (state.callId) CallRecords.update(state.callId, { notes: text }); };
      ta.addEventListener("input", () => saveNotes(ta.value));
      lab.appendChild(templatePicker(ta, saveNotes));
      lab.appendChild(ta); card.appendChild(lab);
      card.appendChild(callbackField());
      card.appendChild(consentField());
      card.appendChild(el("p", "hint", "Result written to row " + (sheet.idx + 2) + " of the sheet. Download the updated sheet when you finish calling."));
      const ni = nextOpen(sheet);
      const nx = tool("lead-next-open", ni < 0 ? "All leads called" : I18n.t("btn.nextLead"), () => loadLead(ni), "primary"); nx.disabled = ni < 0;
      row.appendChild(nx);
    }
    if (lastOutcome && sheet && !state.practice && lastOutcome.code === state.node && lastOutcome.rowIndex === sheet.idx && lastOutcome.sheetName === sheet.fileName) {
      const undoBtn = tool("outcome-undo", I18n.t("btn.undo"), undoOutcome, "plain");
      undoBtn.title = "Puts this lead back as it was and returns to the last question";
      row.appendChild(undoBtn);
    }
    if (row.childNodes.length) card.appendChild(row);
  } else {
    card.appendChild(el("span", "label", "Read this aloud"));
    const say = el("div", "say");
    node.say.forEach((line) => { const p = el("p"); fillInto(p, line); say.appendChild(p); });
    card.appendChild(say);
    if (node.tip) card.appendChild(el("p", "tip", node.tip));
    const single = node.opts.length === 1;
    card.appendChild(el("p", "label ask", single ? "When you have said it" : "How did they respond?"));
    const wrap = el("div", "answers" + (single ? " one" : ""));
    const from = state.node;
    node.opts.forEach((o) => wrap.appendChild(mk(o.k, WORD[o.k], o.hint, () => go(o.to, { node: from, k: o.k }))));
    card.appendChild(wrap);
  }
  stage.appendChild(card);
  $("back").disabled = !state.history.length && state.objection == null;
  // The objection chips jump to built-in steps, so they are off while a published script is in use.
  $("obj-section").hidden = !!node.end || ACTIVE !== BUILTIN;
  renderLeads();
}

OBJECTIONS.forEach((o, i) => {
  const b = el("button", "chip", o.chip); b.type = "button"; b.id = "obj-" + i;
  b.addEventListener("click", () => { if (!state.objs.includes(o.chip)) state.objs.push(o.chip); state.objection = i; render(); window.scrollTo({ top: 0, behavior: "auto" }); });
  $("chips-" + o.g).appendChild(b);
});
$("back").addEventListener("click", back);
$("restart").addEventListener("click", restart);
$("lead-name").addEventListener("input", () => { if (state.objection != null || !FLOW[state.node].end) render(); });
$("me-name").addEventListener("input", () => { try { localStorage.setItem("vca2-me", $("me-name").value); } catch (e) {} if (state.objection != null || !FLOW[state.node].end) render(); });
$("sheet-file").addEventListener("change", (ev) => { const f = ev.target.files && ev.target.files[0]; if (f) readSheet(f); ev.target.value = ""; });
$("lead-search").addEventListener("input", renderLeads);
$("lead-filter").addEventListener("change", renderLeads);
try { const saved = localStorage.getItem("vca2-me"); if (saved) $("me-name").value = saved; } catch (e) {}
function restoreSheet() {
  const s = Vault.get("sheet");
  if (s && s.rows && s.cols && s.rows[s.idx]) { sheet = s; ensureResultCols(s); refreshPhoneFlags(); $("lead-name").value = leadName(); }
}

/* One-time copy from v1 (same github.io origin, so same localStorage). The v1 sheet is read, then removed once it is saved here. */
function v1Sheet() { try { const raw = localStorage.getItem("vcg-sheet"); const s = raw && JSON.parse(raw); return s && s.rows && s.cols && s.rows[s.idx] ? s : null; } catch (e) { return null; } }
function syncImportButton() { $("import-v1").hidden = !!sheet || !v1Sheet(); }
$("import-v1").addEventListener("click", () => {
  if (state.practice) { note(I18n.t("practice.blocked")); return; }
  const s = v1Sheet(); if (!s) { syncImportButton(); return; }
  sheet = s;
  ensureResultCols(s); refreshPhoneFlags();
  // The old copy in localStorage (vcg-sheet) is removed only once the sheet is saved here.
  persist().then((ok) => { if (ok) { try { localStorage.removeItem("vcg-sheet"); } catch (e) {} } });
  try { const me = localStorage.getItem("vcg-me"); if (me && !localStorage.getItem("vca2-me")) { $("me-name").value = me; localStorage.setItem("vca2-me", me); } } catch (e) {}
  $("lead-name").value = leadName(); resetCall(); render();
  note("Imported " + s.fileName + " from the old call guide. The old copy has been removed from this browser.");
});

document.addEventListener("keydown", (ev) => {
  if ($("app").hidden) return;
  if (document.querySelector(".modal-wrap:not([hidden])")) return;   // a dialog is open: no script shortcuts   // pairing screen: no script shortcuts
  const tag = ev.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  const map = { "1": "yes", "2": "no", "3": "maybe" };
  if ((ev.key === "ArrowLeft" || ev.key === "ArrowRight") && sheet) {
    if (leaveBlocked()) { note(leaveMessage()); return; }
    const to = sheet.idx + (ev.key === "ArrowLeft" ? -1 : 1);
    if (to >= 0 && to < sheet.rows.length) { ev.preventDefault(); note(""); loadLead(to); }
    return;
  }
  if (map[k]) { const b = $("ans-" + map[k]); if (b) { ev.preventDefault(); b.click(); } }
  else if (k === "enter" && tag !== "BUTTON" && tag !== "A") { const b = $("ans-next"); if (b) { ev.preventDefault(); b.click(); } }
  else if (k === " " || k === "backspace") { ev.preventDefault(); back(); }   // Space (or Backspace): back one step
  else if (k === "c") {
    const b = $("call-laptop");
    if (b && !b.disabled) { ev.preventDefault(); b.click(); }
    else if (b) note(TermsGate.allowed() ? "The phone is not reachable, so the call cannot start. See the banner at the top of the page." : I18n.t("call.blockedTerms"));
  }
});

$("link-scan").addEventListener("click", startScan);
$("scan-cancel").addEventListener("click", stopScan);
$("cert-retry").addEventListener("click", () => {
  if (pendingPair) pairWith(pendingPair.host, pendingPair.code); else note("Scan the pairing QR again.");
});
$("link-pair").addEventListener("click", pairFromUi);
/* Pairing code box: upper case, and a dash after every 4 characters as you type or paste.
   The cursor stays after the same character, so editing in the middle still works. */
$("link-code").addEventListener("input", (ev) => {
  const box = ev.target;
  const before = box.value.slice(0, box.selectionStart).replace(/[^0-9a-z]/gi, "").length;
  const raw = box.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 16);
  box.value = raw.replace(/(.{4})(?=.)/g, "$1-");
  const pos = Math.min(before, raw.length);
  const caret = pos + Math.floor(Math.max(0, pos - 1) / 4);
  box.setSelectionRange(caret, caret);
});
$("link-forget").addEventListener("click", forgetPhone);
/* The sheet, call records and link key load from IndexedDB first; nothing is drawn before they are in. */
Promise.all([Vault.ready, PhoneLink.ready]).then(() => {
  appReady = true;
  restoreSheet();
  refreshLinkPanel();
  render();
  resumeLastCall();
  checkPhone();
  loadPublishedScript();
});
let cloudStatus = "";
Cloud.onChange((c) => {
  refreshLinkPanel();
  if (c.status !== cloudStatus) {
    cloudStatus = c.status;
    if (c.status === "ready") cloudSweep();   // catch up after signing in
    // Signing in or out changes which script the rep gets. Going offline keeps the script in use.
    if (appReady && (c.status === "ready" || c.status === "signed_out" || c.status === "no_seat")) loadPublishedScript();
  }
});
TermsGate.init();
Cloud.init();
setInterval(cloudSweep, 30000);
$("signin-send").addEventListener("click", sendSigninLink);
$("signin-email").addEventListener("keydown", (ev) => { if (ev.key === "Enter") sendSigninLink(); });
$("signin-password").addEventListener("keydown", (ev) => { if (ev.key === "Enter") sendSigninLink(); });
$("signin-password").addEventListener("input", syncSigninButton);
$("cloud-signout").addEventListener("click", () => { $("cloud-panel").open = false; Cloud.signOut(); });
setInterval(checkPhone, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkPhone(); });

/* ---- Practice, consent, callback reminders, and the page modules (i18n, settings, terms, feedback, timeout, walkthrough) ---- */

/* Practice: walks the same script with nothing written: no outcome, lead or cloud record. */
function renderPractice() {
  $("practice-banner").hidden = !state.practice;
  $("practice-start").hidden = !!state.practice;
}
function startPractice() {
  if (state.practice) return;
  const live = callView && (callView.phase === "REQUESTED" || callView.phase === "OFFHOOK");
  if (live || state.history.length || state.objection != null) { note(I18n.t("practice.blockedStart")); return; }
  note("");
  state.practice = true;
  resetCall();
  render();
  window.scrollTo({ top: 0, behavior: "auto" });
}
function exitPractice() {
  state.practice = false;
  resetCall();
  note("");
  render();
}

/* Consent for this lead. Written to the sheet in English (the values the institute reads), with the date.
   It stays on this laptop: the cloud upload only carries the call outcome and timings. */
const CONSENT_VALUES = ["Not recorded", "Consent given", "Consent refused"];
const CONSENT_KEYS = { "Not recorded": "consent.none", "Consent given": "consent.given", "Consent refused": "consent.refused" };
function consentField() {
  const wrap = el("label", "field cbfield");
  wrap.appendChild(el("span", "label", I18n.t("consent.label")));
  const sel = el("select");
  sel.id = "lead-consent";
  CONSENT_VALUES.forEach((v) => sel.appendChild(new Option(I18n.t(CONSENT_KEYS[v]), v)));
  const cur = String(sheet.rows[sheet.idx][sheet.cols.consent] || "").trim();
  sel.value = CONSENT_VALUES.includes(cur) ? cur : "Not recorded";
  const hint = el("span", "hint");
  const showHint = () => {
    const d = LeadList.validDate(sheet.rows[sheet.idx][sheet.cols.consentDate]);
    hint.textContent = I18n.t("consent.hint") + (sel.value !== "Not recorded" && d ? " " + I18n.t("consent.on", { date: d }) : "");
  };
  sel.addEventListener("change", () => {
    const row = sheet.rows[sheet.idx];
    row[sheet.cols.consent] = sel.value;
    row[sheet.cols.consentDate] = sel.value === "Not recorded" ? "" : LeadList.todayIso();
    persist();
    showHint();
  });
  showHint();
  wrap.appendChild(sel);
  wrap.appendChild(hint);
  return wrap;
}

/* A callback date saved: the phone is asked to remind the rep at 09:00 local time that day. Only the time and
   the text "Callback due" go to the phone: no name, no number. Failures are ignored. */
function requestCallbackReminder(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m || !PhoneLink.isPaired()) return;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0, 0, 0).getTime();
  try { PhoneLink.request("remind", { at: at, text: "Callback due" }).catch(() => {}); } catch (e) {}
}

$("practice-start").addEventListener("click", startPractice);
$("practice-exit").addEventListener("click", exitPractice);
TermsGate.onChange(() => render());
Feedback.init();
SessionTimeout.init();
Onboarding.init();
AccessSettings.init({ onChange: () => render() });   // before the first render, so the chosen language applies
