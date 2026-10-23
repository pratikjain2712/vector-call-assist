/*DATA*/
const STAGES = ["Opening", "Discovery", "Pitch", "Timings", "Fee", "Close"];
const SITE = "https://vector.techsimplus.com/";
// The 20% offer (₹5,000 off, ₹20,000 instead of ₹25,000) ends on 30 October 2026, India time. From 31 October
// the script quotes the regular fee of ₹25,000 and the 11 November registration close instead.
const OFFER_ON = Date.now() < Date.parse("2026-10-31T00:00:00+05:30");
const offer = (on, off) => (OFFER_ON ? on : off);

let FLOW = {
  open: { stage: 0, say: ["Hello, am I speaking with {name}?"], tip: "Smile before you speak. Speak slowly.",
    opts: [{ k: "yes", hint: "It is them", to: "intro" }, { k: "no", hint: "Someone else picked up", to: "wrong_person" }, { k: "maybe", hint: "“Who is this?”", to: "intro" }] },
  wrong_person: { stage: 0, say: ["Oh, sorry! Is {name} there?"],
    opts: [{ k: "yes", hint: "Gives the phone to them", to: "intro" }, { k: "no", hint: "Wrong number", to: "exit_wrong" }, { k: "maybe", hint: "Not there right now", to: "callback" }] },
  intro: { stage: 0, say: ["Hi {name}, this is {me} from TechSimPlus.", offer("You had enquired about our Gen-AI course, Vector 2.0. We have a 20% discount running right now. Is this a good time to talk?", "You had enquired about our Gen-AI course, Vector 2.0. Is this a good time to talk?")],
    opts: [{ k: "yes", hint: "Can talk", to: "q_curriculum" }, { k: "no", hint: "Busy", to: "callback" }, { k: "maybe", hint: "“What is this about?”", to: "intro_maybe" }] },
  intro_maybe: { stage: 0, say: ["Sure. Vector 2.0 is our live Gen-AI course.", "I want to see if it is useful for you. Can I ask two small questions?"],
    opts: [{ k: "yes", hint: "Go ahead", to: "q_work" }, { k: "no", hint: "Not interested", to: "ni_soft" }, { k: "maybe", hint: "Not now", to: "callback" }] },
  ni_soft: { stage: 0, say: ["No problem. Only one question before I go.", "Do you want to move into Gen-AI in your career?"], tip: "Ask only once. If it is still no, end the call politely.",
    opts: [{ k: "yes", hint: "Yes", to: "q_work" }, { k: "no", hint: "No", to: "exit_polite" }, { k: "maybe", hint: "“Just send me the details”", to: "send_details" }] },
  send_details: { stage: 0, say: ["Sure, I will send it on WhatsApp.", "Can I call you again after two or three days?"],
    opts: [{ k: "yes", hint: "Okay", to: "end_details" }, { k: "no", hint: "Do not call", to: "followup_n" }, { k: "maybe", hint: "“I will see”", to: "end_details" }] },
  callback: { stage: 0, say: ["No problem. When can I call you? This evening, or tomorrow?"], tip: "Write down the time before you cut the call.",
    opts: [{ k: "yes", hint: "Gave a time", to: "callback_ok" }, { k: "no", hint: "“Do not call back”", to: "exit_dnc" }, { k: "maybe", hint: "“Just message me”", to: "followup_n" }] },
  callback_ok: { stage: 0, say: ["Okay, I will call you then. Thank you, {name}!"],
    opts: [{ k: "next", hint: "Call finished", to: "end_callback" }] },

  // Intro call, 2 to 5 minutes: short steps, one stage at a time, then book a full call.
  i_open: { stage: 0, say: ["Hello, am I speaking with {name}?"], tip: "Smile before you speak. Speak slowly.",
    opts: [{ k: "yes", hint: "It is them", to: "i_intro" }, { k: "no", hint: "Someone else picked up", to: "i_wrong" }, { k: "maybe", hint: "“Who is this?”", to: "i_intro" }] },
  i_wrong: { stage: 0, say: ["Oh, sorry! Is {name} there?"],
    opts: [{ k: "yes", hint: "Gives the phone to them", to: "i_intro" }, { k: "no", hint: "Wrong number", to: "exit_wrong" }, { k: "maybe", hint: "Not there right now", to: "callback" }] },
  i_intro: { stage: 0, say: ["Hi {name}, this is {me} from TechSimPlus.", offer("You had enquired about our Gen-AI course, Vector 2.0. We have a 20% discount running right now. Do you have 2 minutes?", "You had enquired about our Gen-AI course, Vector 2.0. Do you have 2 minutes?")],
    opts: [{ k: "yes", hint: "Has 2 minutes", to: "i_work" }, { k: "no", hint: "Busy", to: "callback" }, { k: "maybe", hint: "“What is this about?”", to: "i_about" }] },
  i_about: { stage: 0, say: ["Sure. Vector 2.0 is our live online Gen-AI course for developers.", "Can I ask you two quick questions?"],
    opts: [{ k: "yes", hint: "Go ahead", to: "i_work" }, { k: "no", hint: "Not interested", to: "ni_soft" }, { k: "maybe", hint: "Not now", to: "callback" }] },
  i_work: { stage: 1, say: ["Great. What do you do currently?"], tip: "Just note their job, or that they are a student. Do not go deep on this call.",
    opts: [{ k: "yes", hint: "Working in IT or tech", to: "i_python" }, { k: "no", hint: "Student or fresher", to: "i_student" }, { k: "maybe", hint: "Working, non-tech job", to: "i_python" }] },
  i_student: { stage: 1, say: ["Okay. Do you know Python?"], tip: "The course is mainly for working engineers. Students with good Python can still join.",
    opts: [{ k: "yes", hint: "Knows Python", to: "i_pitch" }, { k: "no", hint: "No Python", to: "i_python_no" }, { k: "maybe", hint: "A little", to: "i_python_ok" }] },
  i_python: { stage: 1, say: ["Okay. And do you know Python?"],
    opts: [{ k: "yes", hint: "Knows Python", to: "i_pitch" }, { k: "no", hint: "No Python", to: "i_python_no" }, { k: "maybe", hint: "A little", to: "i_python_ok" }] },
  i_python_no: { stage: 1, say: ["No problem. Do you know any other coding language?"], tip: "If yes: we give recorded Python classes before the batch starts.",
    opts: [{ k: "yes", hint: "Knows another language", to: "i_python_ok" }, { k: "no", hint: "No coding at all", to: "exit_notfit" }, { k: "maybe", hint: "A little", to: "i_python_ok" }] },
  i_python_ok: { stage: 1, say: ["That is fine. We give you Python classes from the basics, before the batch starts.", "Let me quickly tell you about the course."],
    opts: [{ k: "next", hint: "Go to the pitch", to: "i_pitch" }] },
  i_pitch: { stage: 2, say: ["Okay, so Vector 2.0 is a 3-month live online course by Prateek Mishra, a senior Gen-AI developer.", "You learn LangChain, RAG, AI agents and AWS, and build five real apps for your resume.", "Does this sound good?"], tip: "Link it to the job they told you about. Keep it short: the details are for the full call.",
    opts: [{ k: "yes", hint: "Yes, interested", to: "i_time" }, { k: "no", hint: "Not convinced", to: "i_no" }, { k: "maybe", hint: "Not sure yet", to: "i_unsure" }] },
  i_unsure: { stage: 2, say: ["Okay. What is on your mind?", "The topics, the timings, or the fees?"], tip: "If they name a worry, tap it in the list and answer it. Then come back here.",
    opts: [{ k: "yes", hint: "Doubt cleared", to: "i_time" }, { k: "no", hint: "Not interested", to: "exit_polite" }, { k: "maybe", hint: "Wants details first", to: "i_next" }] },
  i_no: { stage: 2, say: ["Okay. Can I ask why?"], tip: "Listen. Tap the matching worry in the list, then come back here.",
    opts: [{ k: "yes", hint: "Worry answered", to: "i_time" }, { k: "no", hint: "Still a no", to: "exit_polite" }, { k: "maybe", hint: "Wants details first", to: "i_next" }] },
  i_time: { stage: 3, say: ["Now, the timings. Two weekday classes, morning or night, and one longer class on the weekend.", "All online, and every class is recorded. Will that work for you?"],
    opts: [{ k: "yes", hint: "Can manage", to: "i_fee" }, { k: "no", hint: "No time now", to: "i_notime" }, { k: "maybe", hint: "Worried about time", to: "i_timeok" }] },
  i_timeok: { stage: 3, say: ["Do not worry. If you miss a class, you can watch the recording later."],
    opts: [{ k: "next", hint: "Go to the fee", to: "i_fee" }] },
  i_notime: { stage: 3, say: ["I understand. Shall I send you the details for later?"], tip: "Thank them and end the call.",
    opts: [{ k: "yes", hint: "Okay, send them", to: "end_details" }, { k: "no", hint: "No need", to: "exit_polite" }, { k: "maybe", hint: "Maybe later", to: "end_details" }] },
  i_fee: { stage: 4, say: offer(["Okay, the full fee is ₹25,000. With the 20% offer, you save ₹5,000, so it is ₹20,000 till 30 October.", "You can start with just ₹6,000, and pay the rest in 15 days."], ["Okay, the fee is ₹25,000.", "You can start with just ₹6,000, and pay the rest in 15 days."]), tip: "Now stop talking. Let them speak first.",
    opts: [{ k: "yes", hint: "Ready to join now", to: "close" }, { k: "no", hint: "Too expensive", to: "fee_no" }, { k: "maybe", hint: "Wants to think", to: "i_next" }] },
  i_next: { stage: 5, say: ["Okay. I will send you the details on WhatsApp.", "Can we talk for 10 minutes, tomorrow or this weekend? I will explain everything."], tip: "Book the time now. On that call, choose Full call.",
    opts: [{ k: "yes", hint: "Gave a time", to: "i_booked" }, { k: "no", hint: "“Just send the details”", to: "followup_n" }, { k: "maybe", hint: "Will message a time", to: "end_details" }] },
  i_booked: { stage: 5, say: ["Great, I will call you then. Thank you, {name}!"],
    opts: [{ k: "next", hint: "Call finished", to: "end_followup" }] },

  q_curriculum: { stage: 1, say: ["Thank you! I will keep it short.", "First, did you get a chance to see the course syllabus?"],
    opts: [{ k: "yes", hint: "Saw it", to: "curr_yes" }, { k: "no", hint: "Not yet", to: "q_work" }, { k: "maybe", hint: "Saw a little", to: "q_work" }] },
  curr_yes: { stage: 1, say: ["Great. Do you have any doubts before you decide?", "If it is a technical doubt, I can set up a call with our tech team."], tip: "Write down their doubts. Answer what you can from the worries list.",
    opts: [{ k: "yes", hint: "Wants a tech team call", to: "techcall" }, { k: "no", hint: "No doubts, continue", to: "q_work" }, { k: "maybe", hint: "Asked a doubt, answered it", to: "q_work" }] },
  techcall: { stage: 1, say: ["Sure, I will set it up. What time suits you, this evening or tomorrow?", "Till then, can I ask you two small questions?"], tip: "Write down the time and their doubt before you go ahead.",
    opts: [{ k: "yes", hint: "Gave a time, happy to continue", to: "q_work" }, { k: "no", hint: "Gave a time, has to go", to: "end_techcall" }, { k: "maybe", hint: "Will message a time", to: "end_techcall" }] },
  q_work: { stage: 1, say: ["So, what do you do currently?"], tip: "Let them talk. If they do not tell you, ask: how many years of experience do you have? Note the role and years. You will use them in the pitch.",
    opts: [{ k: "yes", hint: "Working developer or engineer", to: "q_python" }, { k: "no", hint: "Student or fresher", to: "fresher" }, { k: "maybe", hint: "Non-coding job", to: "q_python" }] },
  fresher: { stage: 1, say: ["Okay. To be honest, this course is made for working engineers.", "But if your Python is good, you can still join. How is your Python?"],
    opts: [{ k: "yes", hint: "Good", to: "q_genai" }, { k: "no", hint: "Weak or none", to: "python_no" }, { k: "maybe", hint: "Basic", to: "python_maybe" }] },
  q_python: { stage: 1, say: ["Nice. Do you know Python well?"],
    opts: [{ k: "yes", hint: "Writes Python", to: "q_genai" }, { k: "no", hint: "Does not code in Python", to: "python_no" }, { k: "maybe", hint: "A little", to: "python_maybe" }] },
  python_no: { stage: 1, say: ["To be honest, this course needs Python.", "If you know another coding language, we give you recorded Python classes. Can you finish them before 21 November?"],
    opts: [{ k: "yes", hint: "Will do it", to: "q_genai" }, { k: "no", hint: "Not ready", to: "exit_notfit" }, { k: "maybe", hint: "Not sure", to: "q_genai" }] },
  python_maybe: { stage: 1, say: ["That is okay. We give you recorded Python classes to finish before the batch starts. You will be fine."],
    opts: [{ k: "next", hint: "Next question", to: "q_genai" }] },
  q_genai: { stage: 1, say: ["Have you tried learning Gen-AI before?", "From YouTube, or any course?"],
    opts: [{ k: "yes", hint: "Tried something", to: "q_scale" }, { k: "no", hint: "Nothing yet", to: "genai_no" }, { k: "maybe", hint: "Did a course, it was not useful", to: "burned" }] },
  genai_no: { stage: 1, say: ["Perfect, this course is made for people like you.", "We start from the basics, step by step."],
    opts: [{ k: "next", hint: "Next question", to: "q_goal" }] },
  burned: { stage: 1, say: ["Many people tell me the same thing. What was the problem?", "Was it only recorded videos?"], tip: "Let them talk. Do not argue for other courses.",
    opts: [{ k: "yes", hint: "Recorded, no support", to: "burned_yes" }, { k: "no", hint: "Does not trust any course now", to: "trust" }, { k: "maybe", hint: "Many reasons", to: "burned_yes" }] },
  burned_yes: { stage: 1, say: ["Yes, this happens a lot.", "This course is live. There are deadlines. And a mentor checks your work."],
    opts: [{ k: "next", hint: "Next question", to: "q_goal" }] },
  trust: { stage: 1, say: ["I understand. You do not have to just believe me.", "We give a full refund within 3 days, no questions asked. So there is no risk. Shall I tell you more?"],
    opts: [{ k: "yes", hint: "Okay", to: "q_goal" }, { k: "no", hint: "No", to: "exit_polite" }, { k: "maybe", hint: "Go on", to: "q_goal" }] },
  q_scale: { stage: 1, say: ["Okay. Suppose in an interview they ask you, “How will you make this app work for 10 lakh users?”", "Can you answer that today?"], tip: "If they say no, this is exactly what the course teaches. Remember it for the pitch.",
    opts: [{ k: "yes", hint: "Does this at work", to: "experienced" }, { k: "no", hint: "Would find it hard", to: "q_goal" }, { k: "maybe", hint: "Partly", to: "q_goal" }] },
  experienced: { stage: 1, say: ["Very good. Then the first weeks will be revision for you.", "But later we do fine-tuning, Azure AI, Kubernetes and scaling to lakhs of users. Have you done these at work?"], tip: "Most working engineers have not done all of these. That is the pitch for them.",
    opts: [{ k: "yes", hint: "Done all of these", to: "exit_notfit" }, { k: "no", hint: "Some gaps", to: "q_goal" }, { k: "maybe", hint: "Not all", to: "q_goal" }] },
  q_goal: { stage: 1, say: ["What is your plan? Do you want a Gen-AI job?"],
    opts: [{ k: "yes", hint: "Wants a Gen-AI job", to: "pitch1" }, { k: "no", hint: "Just checking", to: "goal_no" }, { k: "maybe", hint: "Open to it", to: "pitch1" }] },
  goal_no: { stage: 1, say: ["Okay. But many jobs now ask for Gen-AI skills.", "When you change jobs, will real projects on your GitHub help you?"],
    opts: [{ k: "yes", hint: "It would", to: "pitch1" }, { k: "no", hint: "Happy in current job", to: "goal_no2" }, { k: "maybe", hint: "Maybe", to: "pitch1" }] },
  goal_no2: { stage: 1, say: ["Okay, no problem.", "Can I send you the details on WhatsApp, in case you change your mind?"],
    opts: [{ k: "yes", hint: "Sure", to: "end_details" }, { k: "no", hint: "No need", to: "exit_polite" }, { k: "maybe", hint: "Fine", to: "end_details" }] },

  pitch1: { stage: 2, say: ["Okay, let me tell you about the course.", "It is a 3-month live course, and Prateek Mishra teaches it.", "He is a senior Gen-AI developer in an MNC, with 8 years of experience. Okay so far?"], tip: "Start with their own words: their job, their goal, and the problem they told you about.",
    opts: [{ k: "yes", hint: "Following", to: "pitch2" }, { k: "no", hint: "“Never heard of him”", to: "trust_brand" }, { k: "maybe", hint: "Listening", to: "pitch2" }] },
  trust_brand: { stage: 2, say: ["Yes, we are not a big brand.", "But he has taught more than 12,000 engineers, and his LinkedIn is public. I will send it to you. Shall I go on?"],
    opts: [{ k: "yes", hint: "Go on", to: "pitch2" }, { k: "no", hint: "Not convinced", to: "exit_polite" }, { k: "maybe", hint: "Okay", to: "pitch2" }] },
  pitch2: { stage: 2, say: ["You learn the main Gen-AI tools, like LangChain, RAG, AI agents and AWS.", "Also, you build five real apps and put them live, and these really help your resume get shortlisted.", "Sounds interesting, right?"], tip: "If they want an example: one app answers questions from RBI circulars. Pause. Do not rush.",
    opts: [{ k: "yes", hint: "Interested", to: "pitch3" }, { k: "no", hint: "Not useful for them", to: "pitch_no" }, { k: "maybe", hint: "No reaction", to: "pitch3" }] },
  pitch3: { stage: 2, say: ["The best part: five one-on-one mock interviews, with written feedback.", "You also get a personal mentor for doubts, and a Demo Day with hiring companies.", "Is this what you were looking for?"],
    opts: [{ k: "yes", hint: "Yes", to: "time" }, { k: "no", hint: "Not convinced", to: "pitch_no" }, { k: "maybe", hint: "“What is different?”", to: "diff" }] },
  diff: { stage: 2, say: ["Good question. The biggest difference is five one-on-one mock interviews.", "And it is live, with a mentor who checks your work. Shall I tell you the timings?"],
    opts: [{ k: "yes", hint: "Wants timings", to: "time" }, { k: "no", hint: "Still not convinced", to: "pitch_no" }, { k: "maybe", hint: "Okay", to: "time" }] },
  pitch_no: { stage: 2, say: ["No problem. What is stopping you?", "Please tell me honestly."], tip: "Listen fully. Then tap the matching worry in the list.",
    opts: [{ k: "yes", hint: "Worry answered, interested again", to: "time" }, { k: "no", hint: "Still a no", to: "exit_polite" }, { k: "maybe", hint: "Wants to think", to: "followup" }] },

  time: { stage: 3, say: ["The timings are made for working people.", "Two weekday classes: morning 6:30 to 8:30, or night 8 to 10.", "And a weekend class, 10 to 4. Can you manage this?"], tip: "They can change between the morning and night batch any time. Same topic, same mentor.",
    opts: [{ k: "yes", hint: "Can manage", to: "fee" }, { k: "no", hint: "Too much", to: "time_no" }, { k: "maybe", hint: "Worried about busy weeks", to: "time_no" }] },
  time_no: { stage: 3, say: ["I understand. But every class is recorded.", "If you miss one, you can watch it later. Does that help?"],
    opts: [{ k: "yes", hint: "That helps", to: "fee" }, { k: "no", hint: "Still cannot", to: "time_no2" }, { k: "maybe", hint: "Probably", to: "fee" }] },
  time_no2: { stage: 3, say: ["Okay. Which part is difficult? Weekdays, or weekends?", "You can also change between the morning and night batch when you need."], tip: "Weekdays: recordings and changing batch solve it. Weekends: that is the long class, they should attend most of them.",
    opts: [{ k: "yes", hint: "Can adjust", to: "fee" }, { k: "no", hint: "Cannot give the time", to: "exit_later" }, { k: "maybe", hint: "Needs to check", to: "followup" }] },
  exit_later: { stage: 3, say: ["I understand. It is better to join when you have time.", "I will send you the details on WhatsApp, for later. Thank you, {name}."],
    opts: [{ k: "next", hint: "Call finished", to: "end_details" }] },

  fee: { stage: 4, say: offer(["Now, the fees. The full fee is ₹25,000.", "With the 20% offer, you save ₹5,000, so it is ₹20,000 till 30 October. Everything is included."], ["Now, the fees. It is ₹25,000, and everything is included."]), tip: "Now stop talking. Let them speak first.",
    opts: [{ k: "yes", hint: "Fine with it", to: "close" }, { k: "no", hint: "Too expensive", to: "fee_no" }, { k: "maybe", hint: "Quiet, or “hmm”", to: "fee_maybe" }] },
  fee_maybe: { stage: 4, say: ["And we give a full refund within 3 days, no questions asked.", "So if you do not like it, you get your money back. Okay?"],
    opts: [{ k: "yes", hint: "Okay", to: "close" }, { k: "no", hint: "Still too much", to: "fee_no" }, { k: "maybe", hint: "Wants to think", to: "think" }] },
  fee_no: { stage: 4, say: [offer("I understand. ₹20,000 is a big amount.", "I understand. ₹25,000 is a big amount."), "You can pay in two parts. ₹6,000 to join, and the rest within 15 days. Does that help?"],
    opts: [{ k: "yes", hint: "Two parts works", to: "close" }, { k: "no", hint: "Still too much", to: "fee_no2" }, { k: "maybe", hint: "Needs to think", to: "think" }] },
  fee_no2: { stage: 4, say: ["Okay. One question. If money was not a problem, would you join?"],
    opts: [{ k: "yes", hint: "Yes, only the fee", to: "fee_only" }, { k: "no", hint: "Not sure about the course", to: "pitch_no" }, { k: "maybe", hint: "Needs to think", to: "think" }] },
  fee_only: { stage: 4, say: ["Okay, so only the fee is the problem.", "I cannot promise anything more. But I will check with my team and message you today. Okay?"], tip: "Do not promise a discount. Paying in two parts is the only option you can offer.",
    opts: [{ k: "yes", hint: "Fine", to: "end_followup" }, { k: "no", hint: "Leave it", to: "exit_polite" }, { k: "maybe", hint: "Okay", to: "end_followup" }] },

  close: { stage: 5, say: ["Honestly, I think this course suits you.", offer("Shall I send you the link on WhatsApp now? You get ₹5,000 off, and you can join with just ₹6,000.", "Shall I send you the link on WhatsApp now? You can join with just ₹6,000.")], tip: offer("If they hesitate: the 20% offer ends on 30 October, and registrations close on 11 November.", "If they hesitate: registrations close on 11 November."),
    opts: [{ k: "yes", hint: "Send it", to: "won" }, { k: "no", hint: "Not now", to: "think" }, { k: "maybe", hint: "“Let me think”", to: "think" }] },
  won: { stage: 5, say: ["Great, I am sending it now. This is your WhatsApp number, right?", "I will message you tomorrow. Welcome to Vector 2.0, {name}!"],
    opts: [{ k: "next", hint: "Call finished", to: "end_won" }] },
  think: { stage: 5, say: ["Sure, take your time.", "Just tell me, what is stopping you? Time, fees, or the course?"], tip: "Answer it from the worries list, then come back here.",
    opts: [{ k: "yes", hint: "Doubt cleared, ready to join", to: "won" }, { k: "no", hint: "Clear no", to: "exit_polite" }, { k: "maybe", hint: "Still wants time", to: "followup" }] },
  followup: { stage: 5, say: ["No problem. I will send you the syllabus on WhatsApp.", offer("When can I call you again? The 20% offer ends on 30 October.", "When can I call you again? Registrations close on 11 November.")], tip: "Fix a day and time with them before you end the call.",
    opts: [{ k: "yes", hint: "Gave a time", to: "end_followup" }, { k: "no", hint: "“I will call you”", to: "followup_n" }, { k: "maybe", hint: "Not sure when", to: "followup_time" }] },
  followup_time: { stage: 5, say: ["Sure. Which day is good for you?", "Okay, I will call you then. Thank you, {name}!"],
    opts: [{ k: "next", hint: "Time agreed", to: "end_followup" }] },
  followup_n: { stage: 5, say: ["Sure, no problem. I will just send the details.", "Message me when you are ready. Thank you, {name}!"],
    opts: [{ k: "next", hint: "Call finished", to: "end_details" }] },

  exit_polite: { stage: 5, say: ["No problem at all, {name}. Thank you for your time.", "Have a nice day!"],
    opts: [{ k: "next", hint: "Call finished", to: "end_lost" }] },
  exit_notfit: { stage: 5, say: ["Then, {name}, this course is not right for you right now.", "Thank you for your time!"],
    opts: [{ k: "next", hint: "Call finished", to: "end_lost" }] },
  exit_wrong: { stage: 0, say: ["Oh, sorry to disturb you. Have a nice day!"],
    opts: [{ k: "next", hint: "Call finished", to: "end_wrong" }] },
  exit_dnc: { stage: 0, say: ["Okay. I will not call again.", "Sorry for the trouble. Take care."],
    opts: [{ k: "next", hint: "Call finished", to: "end_dnc" }] },

  end_won: { stage: 5, end: { tone: "good", label: "Enrolling", note: "Send the link within five minutes. Message them tomorrow.",
    msg: "Hi {name}, this is {me} from TechSimPlus. Nice talking to you.\n\nHere is the Vector 2.0 joining page: " + SITE + "\n\n" + offer("Offer: 20% off, so ₹20,000 instead of ₹25,000, till 30 Oct. ", "Fee: ₹25,000. ") + "Start with ₹6,000 and pay the rest within 15 days. Full refund within 3 days. Registrations close on 11 Nov, and the batch starts on 21 Nov.\n\nMessage me here if you need any help." } },
  end_followup: { stage: 5, end: { tone: "mid", label: "Follow-up booked", note: "Send this now. Put the follow-up in your calendar.",
    msg: "Hi {name}, this is {me} from TechSimPlus. Nice talking to you. Here are the Vector 2.0 details: " + SITE + "\n\n" + offer("Offer: 20% off, so ₹20,000 instead of ₹25,000, till 30 Oct. ", "Fee: ₹25,000. ") + "Start with ₹6,000 and pay the rest within 15 days.\n\nI will call you at the time we agreed." } },
  end_callback: { stage: 0, end: { tone: "mid", label: "Call back later", note: "Send this so they know your number next time.",
    msg: "Hi {name}, this is {me} from TechSimPlus. I called about Vector 2.0, our live Gen-AI course." + offer(" There is a 20% offer till 30 Oct.", "") + " I will call you at the time we agreed.\n\nDetails, if you want to see them first: " + SITE } },
  end_techcall: { stage: 1, end: { tone: "mid", label: "Tech team call", note: "Book the tech team call now. Pass on their doubts.",
    msg: "Hi {name}, this is {me} from TechSimPlus. Nice talking to you. I am setting up a call with our tech team for your Vector 2.0 doubts, at the time we agreed.\n\nCourse details: " + SITE + "\n\n" + offer("Offer: 20% off, so ₹20,000 instead of ₹25,000, till 30 Oct. ", "Fee: ₹25,000. ") + "Registrations close on 11 Nov.\n\nMessage me here if you want to change the time." } },
  end_details: { stage: 5, end: { tone: "mid", label: "Details only", note: "Send this once. Do not keep calling unless they agreed to a call.",
    msg: "Hi {name}, this is {me} from TechSimPlus. Thank you for your time today. Here are the details of Vector 2.0, our live Gen-AI course: " + SITE + "\n\n" + offer("Offer: 20% off, so ₹20,000 instead of ₹25,000, till 30 Oct. ", "Fee: ₹25,000. ") + "Registrations close on 11 Nov, and the batch starts on 21 Nov.\n\nNo hurry. Message me here if you have any questions." } },
  end_noanswer: { stage: 0, end: { tone: "mid", label: "No answer", note: "Send this, then try once more at a different time of day.",
    msg: "Hi {name}, this is {me} from TechSimPlus. I called about your enquiry for Vector 2.0, our Gen-AI course." + offer(" There is a 20% offer till 30 Oct.", "") + " When can I call you for 5 minutes?" } },
  end_lost: { stage: 5, end: { tone: "bad", label: "Not this time", note: "No message needed. Note the reason they gave. It will help your next call." } },
  end_wrong: { stage: 0, end: { tone: "bad", label: "Wrong number", note: "Mark the number as wrong in your lead sheet." } },
  end_dnc: { stage: 0, end: { tone: "bad", label: "Do not call", note: "Mark this lead as do-not-call. No message, no second try." } }
};

const OBJECTIONS = [
  { g: "push", hot: true, chip: "What is Vector 2.0?", say: "Vector 2.0 is our 3-month online Gen-AI course for developers. Prateek Mishra, a senior Gen-AI developer, teaches it live. You build five real apps, and get five mock interviews and a mentor. The batch starts on 21 November.", exit: "exit_polite" },
  { g: "push", hot: true, chip: "What is Gen-AI?", say: "Gen-AI is AI that writes text, code or answers, like ChatGPT. Companies now hire developers who build apps with it. This course teaches you that.", tip: "Keep it simple. Then connect it to the work they do today." },
  { g: "push", chip: "Not interested", say: "No problem. Only one question before I go. Do you want to move into Gen-AI in your career?", exit: "exit_polite" },
  { g: "push", chip: "Where did you get my number?", say: "From the form on our website. You had enquired about Vector 2.0. If you do not want me to call, please tell me.", exit: "exit_dnc" },
  { g: "push", chip: "I never enquired", say: "Oh, sorry about that. Maybe someone typed your number by mistake. Are you interested in learning Gen-AI?", exit: "exit_dnc" },
  { g: "push", chip: "Just WhatsApp me", say: "Sure, I will. One small question, so I send the right details. Do you want a Gen-AI job?", exit: "followup_n" },
  { g: "push", chip: "Can I get a refund?", say: "Yes. If you do not like the course, you get a full refund within 3 days. No questions asked.", exit: "exit_polite" },
  { g: "push", chip: "Is this a scam?", say: "Good question! Please check us first. The trainer’s LinkedIn is public, and there is a full refund within 3 days.", exit: "exit_polite" },
  { g: "push", chip: "Courses are useless", say: "Many people say that. Most courses are recorded videos. This one is live, and a mentor checks your work. Can I tell you more?", exit: "exit_polite" },
  { g: "push", chip: "AI is just hype", say: "Maybe! But most IT companies now hire for Gen-AI roles. This course gets you ready for them.", exit: "exit_polite" },
  { g: "push", chip: "Already in another course", say: "Oh nice. Is it live, with real projects and mock interviews? If not, that is what we give you.", exit: "exit_polite" },
  { g: "push", chip: "Stop calling me", say: "Okay. I will not call again. Sorry for the trouble. Take care.", only: "end_dnc" },
  { g: "push", chip: "They got angry", say: "I am sorry, I did not want to disturb you. I will not take more of your time. Have a nice day.", tip: "Do not argue or explain. End the call calmly.", only: "end_lost" },
  { g: "push", chip: "No answer or call dropped", say: "Hi {name}, this is {me} from TechSimPlus. I will send you a WhatsApp message. Thank you!", tip: "Say this only if you get voicemail. Otherwise just send the message.", only: "end_noanswer" },

  { g: "worry", chip: "What is TechSimPlus?", say: "We are a tech training company in Bhopal. We have trained more than 12,000 students. Vector 2.0 is our live Gen-AI course.", tip: "If they ask about placements: our website lists past students at TCS, Infosys, Wipro, Flipkart and Samsung. That is for TechSimPlus overall, not a promise for Vector." },
  { g: "worry", chip: "Where are you based? Is it online?", say: "Our office is in Bhopal. But Vector 2.0 is fully live online, so you can join from anywhere." },
  { g: "worry", chip: "Too expensive", say: offer("I understand. Right now you get 20% off, so it is ₹20,000 instead of ₹25,000. And you can start with just ₹6,000. Does that help?", "I understand. You can start with just ₹6,000, and pay the rest within 15 days. Does that help?") },
  { g: "worry", chip: "Can I pay in instalments?", say: offer("Yes. ₹6,000 to join, and the rest within 15 days. With the offer, the total is ₹20,000 till 30 October.", "Yes. ₹6,000 to join, and the rest within 15 days."), tip: "Do not promise a discount. For anything more than two parts, ask the team first." },
  { g: "worry", chip: "Placement support? Will I get a job?", say: "Yes, we help you prepare and apply for Gen-AI jobs. You get five mock interviews and a Demo Day with hiring companies. But honestly, nobody can guarantee a job." },
  { g: "worry", chip: "No Gen-AI experience", say: "This course is made for people like you. You need Python, Docker and Git, and we give you classes for all three before the batch starts." },
  { g: "worry", chip: "I do not know Python", say: "If you know any other coding language, you are fine. We give you recorded Python classes to finish before the batch starts." },
  { g: "worry", chip: "No time, full-time job", say: "Most people in the batch are working. Weekdays are only two classes, and every class is recorded. Which batch suits you, morning or night?" },
  { g: "worry", chip: "What if I miss a class?", say: "No problem. You get the recording after every class, and you can watch it for life." },
  { g: "worry", chip: "Can I switch batch?", say: "Yes. Both batches cover the same topic every day, with the same mentor. You can change between morning and night when you need." },
  { g: "worry", chip: "Is there a certificate?", say: "Yes, a certificate signed by the instructor. But honestly, what gets you hired is the five projects on your GitHub." },
  { g: "worry", chip: "Can I see a demo class?", say: "We can share some class recordings from Vector 1.0. The same mentor teaches Vector 2.0, so you will see exactly how he teaches.", tip: "Get the recording link from the team and send it on WhatsApp." },
  { g: "worry", chip: "Are projects production level?", say: "Yes. They are real apps, like in a company. You put them live on AWS, with Docker and CI/CD." },
  { g: "worry", chip: "What is RAG?", say: "RAG means the AI first reads your documents, then answers. So the answers are correct. You build a full RAG project." },
  { g: "worry", chip: "What will I learn?", say: "FastAPI, LangChain, RAG, AI agents, and AI on AWS and Azure. At the end, you learn to run apps for lakhs of users. I will send the full syllabus on WhatsApp." },
  { g: "worry", chip: "Do you teach Azure?", say: "Yes. Everyone learns both AWS Bedrock and Azure AI. Then you choose AWS or Azure for your final project.", tip: "If they ask which one to choose: many IT service companies in India use Azure. Many product companies and startups use AWS." },
  { g: "worry", chip: "What do you cover in cloud?", say: "AWS Bedrock and Azure AI, and training an AI model on your own data. Then you put your final project live on AWS or Azure." },
  { g: "worry", chip: "Do you teach fine-tuning?", say: "Yes. You train an open-source AI model on a real task, using LoRA and QLoRA. You also learn when RAG is better." },
  { g: "worry", chip: "Do you teach AI agents?", say: "Yes. You build AI agents with LangGraph and CrewAI, and connect them with MCP. You also learn to keep them safe." },
  { g: "worry", chip: "What are the five projects?", say: "Five real apps. For example, one reads GST bills, and one answers questions from RBI circulars. The biggest one handles 1 crore requests a day." },
  { g: "worry", chip: "Do I need a GPU?", say: "No. A laptop with 8 GB RAM is enough. For GPU work, we use free or cheap online GPUs." },
  { g: "worry", chip: "Will cloud cost me extra?", say: "A little, but we keep it low. Free AWS and Azure credits cover most of it." },
  { g: "worry", chip: "How many hours a week?", say: "About 20 to 22 hours a week. That is 16 hours of live classes, and some practice on your own." },
  { g: "worry", chip: "Is it in Hindi?", say: "Classes are in English. If something is not clear, the mentor can explain it in Hindi." },
  { g: "worry", chip: "Technical question", say: "Good question. I want our tech team to answer it properly. Shall I set up a short call with them?", tip: "Write down the question and a time that suits them." },
  { g: "worry", chip: "YouTube is free", say: "True, for the basics. But YouTube will not check your code or take your mock interview. Has it made you ready for interviews?" },
  { g: "worry", chip: "Too basic for me", say: "The first weeks may be revision. But later we do fine-tuning, Azure AI, Kubernetes and scaling to lakhs of users. Have you done these at work?" },
  { g: "worry", chip: "150 is a big batch", say: "Yes, up to 150 students. But your final project and mock interviews are one-on-one. And you get a personal mentor." },
  { g: "worry", chip: "Who is the instructor?", say: "Prateek Mishra. Senior Gen-AI developer in an MNC, with 8 years of experience. He taught the first batch also. I will send you his LinkedIn." },
  { g: "worry", chip: "Need to ask family", say: "Of course. What will they ask you? Tell me, and I will give you the answer now." },
  { g: "worry", chip: "I will join next batch", say: offer("You can. But the 20% offer is only for this batch, till 30 October. What will change for you by the next batch?", "You can. But registrations for this batch close on 11 November. What will change for you by the next batch?") },
  { g: "worry", chip: "Will my company pay?", say: "Yes, many companies do. We give a GST invoice for every enrolment." },
  { g: "worry", chip: "I do not know the answer", say: "Good question. I do not want to guess. Let me check with my team, and I will message you today." }
];
/*END*/

const WORD = { yes: "Yes", no: "No", maybe: "Maybe", next: "Next" };
const KEY = { yes: "1", no: "2", maybe: "3", next: "Enter" };
const LABEL = { open: "Right person", wrong_person: "Lead available", intro: "Has time", intro_maybe: "Okay with questions", q_curriculum: "Checked curriculum", curr_yes: "Wants tech team call", techcall: "Continued after booking tech call", ni_soft: "Thinking of Gen-AI", send_details: "Okay to check back", callback: "Gave callback time", q_work: "Working engineer", fresher: "Python good", q_python: "Comfortable with Python", python_no: "Will do pre-work", q_genai: "Tried Gen-AI", burned: "Past course was recorded", trust: "Open to hear more", q_scale: "Can answer scaling question", experienced: "Done it all in production", q_goal: "Wants Gen-AI role", goal_no: "Projects would help", goal_no2: "Okay to send details", pitch1: "Following the pitch", trust_brand: "Okay to continue", pitch2: "Projects interesting", pitch3: "Is what they want", diff: "Wants timings", pitch_no: "Worry answered", time: "Timings doable", time_no: "Recordings help", time_no2: "Can adjust", fee: "Fine with fee", fee_maybe: "Okay after refund", fee_no: "Instalments work", fee_no2: "Would join if fee was no issue", fee_only: "Okay to wait on payment options", close: "Send link now", think: "Ready after worry", followup: "Follow-up agreed", i_intro: "Intro: has 2 minutes", i_about: "Intro: okay with questions", i_work: "Intro: working in tech", i_student: "Intro: student knows Python", i_python: "Intro: knows Python", i_python_no: "Intro: knows another language", i_pitch: "Intro: interested in the course", i_unsure: "Intro: doubt cleared", i_no: "Intro: worry answered", i_time: "Intro: can manage timings", i_notime: "Intro: details for later", i_fee: "Intro: ready to join", i_next: "Intro: booked full call" };
/* Built-in script, two ways in: a short intro call (most first calls) or the full call. The choice is a
   per-browser convenience in localStorage; it holds no lead data. */
const CALL_MODES = { intro: { start: "i_open", aim: "aim 2 to 5 min" }, full: { start: "open", aim: "aim 10 to 12 min" } };
const MODE_KEY = "vca2-call-mode";
let callMode = (() => { try { return own(CALL_MODES, localStorage.getItem(MODE_KEY)) ? localStorage.getItem(MODE_KEY) : "intro"; } catch (e) { return "intro"; } })();
const BUILTIN = { flow: FLOW, start: CALL_MODES[callMode].start, scriptId: null, version: null };   // the built-in script: the fallback
let ACTIVE = BUILTIN;   // the script being walked; see useWanted()
// Phase A: caller. A campaign with no script, or a plan without the Scripts add-on: no steps on screen, only
// the lead card and the result buttons.
const NO_SCRIPT = { flow: { none: { stage: 0, say: [], opts: [], none: true } }, start: "none", scriptId: null, version: null };
// Every script question that has a real choice, in script order. Each gets its own column in the Calls tab.
const QUESTIONS = Object.keys(FLOW).filter((k) => LABEL[k]).map((k) => ({ key: k, label: LABEL[k] }));
const RESULT_COLS = ["Call outcome", "Called at", "Call duration", "Answers", "Objections raised", "Notes", "Callback date", "Consent", "Consent date"];
const RESULT_KEYS = ["outcome", "at", "duration", "answers", "objections", "notes", "callback", "consent", "consentDate"];
const $ = (id) => document.getElementById(id);
// Lookup in a table of built-in ids. A step id such as "constructor" must not find Object.prototype.
const own = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const state = { node: BUILTIN.start, history: [], trail: [], objs: [], objection: null, started: null, elapsed: 0, timer: null, callId: null, practice: false };
let sheet = null;
let phoneCheck = null;   // ImportCheck result for the sheet: flags per lead and counts. Worked out on load, never saved.
let lastOutcome = null;  // the outcome just saved on the end card, for Undo. Cleared when the lead or call changes.
const CALLBACK_OUTCOMES = { end_callback: 1, end_followup: 1, end_noanswer: 1, end_techcall: 1 };   // these keep a callback date
/* Phase A: caller. Campaign calling state (see "Campaign calling" below). Lead money is kept in memory only. */
const camp = {
  list: [], features: null, seat: "", id: null, info: null, leads: [], lead: null, shownAt: 0,
  money: Object.create(null), pick: null, values: {}, begun: false, beganAt: 0, clock: StepClock.create(),
  outbox: [], failed: [], syncing: false, offline: false, msg: "", nextFree: true, resultsSig: "",
  // Phase A: integration. waTemplates: approved WhatsApp templates (my_whatsapp_templates; [] when the institute
  // has no connected number). practice: my_practice() rows, null when unknown or not on this plan.
  waTemplates: [], practice: null, syncAgain: false,
};
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

function names() { return { me: $("me-name").value.trim(), name: campOn() ? (campLead() ? campLead().name : "") : $("lead-name").value.trim() }; }
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
  if (campOn() && !camp.begun) campBegin(Math.max(camp.shownAt, Date.now() - 120000));   // Phase A: caller
  state.history.push({ node: state.node, trail: state.trail.length });
  if (pick && pick.k !== "next") state.trail.push(pick);
  state.node = to; state.objection = null;
  // Phase A: caller. A campaign call is saved with the result buttons, not at the script's end card.
  if (FLOW[to].end && campOn()) { startClock(); render(); return; }
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
function resetCall() { campResetCall(); stopClock(); state.callId = null; state.node = ACTIVE.start; state.history = []; state.trail = []; state.objs = []; state.objection = null; state.elapsed = 0; tick(); }
function restart() { lastOutcome = null; camp.pick = null; camp.values = {}; resetCall(); if (!sheet) $("lead-name").value = ""; render(); }
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
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(CallRecords.toAoa(calls, QUESTIONS, ANSWERS.map((o) => o.chip))), "Calls");
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
  if (campOn()) { $("sheet-empty").hidden = true; bar.hidden = true; return; }   // Phase A: caller
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

  const calls = callButtons(phone, name);
  if (calls.childNodes.length) bar.appendChild(calls);

  // Sheet card: name, progress, and the download.
  sheetCard(tools, n, done);
}

/* The call buttons for a number: "Call on this device" (a tel: link) on phones and tablets, and the call through
   the paired phone. Used by the lead sheet and by the campaign lead card. */
function callButtons(phone, name) {
  const calls = el("div", "calls");
  if (phone && TOUCH && !state.practice && TermsGate.allowed()) {
    const a = el("a", PhoneLink.isPaired() ? "plain" : "primary", "Call on this device");
    a.href = "tel:" + phone.replace(/[^\d+]/g, ""); a.id = "call-link"; calls.appendChild(a);
    a.addEventListener("click", () => campBegin(Date.now()));   // Phase A: caller: the call starts now
  }
  if (phone && PhoneLink.isPaired() && !state.practice) {
    const first = String(name || "").split(/\s+/)[0];
    const cb = tool("call-laptop", TOUCH ? I18n.t("btn.callPhone") : (first ? I18n.t("btn.call", { first: first }) : I18n.t("btn.callPlain")), callFromLaptop, "primary");
    cb.disabled = !(linkHealth === "ok" || linkHealth === "checking") || !TermsGate.allowed();
    cb.title = cb.disabled ? "The phone is not reachable. See the banner at the top of the page." : "Dial this lead on your paired phone (C)";
    if (!TOUCH) cb.appendChild(el("kbd", "btnkey", "C"));
    calls.appendChild(cb);
  }
  return calls;
}

function sheetCard(tools, n, done) {
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
  campSync();   // Phase A: caller: a campaign result may be waiting for this call's connected time
  setCallSummary(sessionId, summary);
  note(summary);
}

/* The lead to dial: the campaign lead on the card (Phase A: caller), or the sheet row on screen. */
function dialTarget() {
  if (campOn()) {
    const l = campLead();
    return l ? { raw: l.phone, name: l.name, rowIndex: null, sheetName: null, leadId: l.id, campaignId: camp.id, notes: "" } : null;
  }
  if (!sheet) return null;
  const r = sheet.rows[sheet.idx];
  return { raw: String(r[sheet.cols.phone]).trim(), name: leadName(), rowIndex: sheet.idx, sheetName: sheet.fileName, leadId: null, campaignId: null, notes: String(r[sheet.cols.notes] || "") };
}

async function callFromLaptop() {
  const t = dialTarget();
  if (!t) return;
  if (state.practice) return;
  if (!TermsGate.allowed()) { note(I18n.t("call.blockedTerms")); return; }
  if (callView && (callView.phase === "REQUESTED" || callView.phase === "OFFHOOK")) { note("A call is already in progress."); return; }
  const raw = t.raw;
  const number = PhoneLink.toE164(raw);
  if (!number) { note("This number cannot be dialled as it is. Check it, or add the country code, for example +91."); return; }
  note("Dialling " + number + " through the phone…");
  let res;
  try { res = await phone("dial", { number: number }); }
  catch (e) { note("Could not dial: " + e.message); return; }
  if (!res.ok) { note("Could not dial: " + res.error); return; }
  CallRecords.add({
    sessionId: res.session, source: "laptop", sheetName: t.sheetName, leadName: t.name, phone: raw, phoneE164: number, rowIndex: t.rowIndex,
    leadId: t.leadId, campaignId: t.campaignId,
    dialWallMs: res.dialWallMs, offhookWallMs: 0, endWallMs: 0, connectedSeconds: null, answered: null,
    detection: "", callStatus: "dialling", outcome: "", objections: "",
    notes: t.notes, saveStatus: "awaiting-outcome", updatedAt: Date.now(),
  });
  campBegin(res.dialWallMs || Date.now());   // Phase A: caller
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
/* Intro call or Full call: switches only while the page is idle, like a published script. */
function setCallMode(mode) {
  if (!own(CALL_MODES, mode) || mode === callMode || !idleForScript()) return;
  callMode = mode;
  try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
  BUILTIN.start = CALL_MODES[mode].start;
  if (ACTIVE === BUILTIN) state.node = BUILTIN.start;
  render();
}
function renderCallMode() {
  const box = $("call-mode");
  box.hidden = ACTIVE !== BUILTIN;
  const idle = idleForScript();
  box.querySelectorAll("[data-mode]").forEach((b) => {
    const on = b.dataset.mode === callMode;
    b.setAttribute("aria-pressed", String(on));
    b.disabled = !on && !idle;
  });
  $("clock-aim").textContent = ACTIVE === BUILTIN ? CALL_MODES[callMode].aim : campOn() ? "" : "aim 10 to 12 min";
}
async function loadPublishedScript() {
  const mine = ++scriptFetch;
  if (campOn()) { await loadCampaignScript(mine); return; }   // Phase A: caller
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
  lines.push(campOn() ? "Campaign leads come from your institute's Vector cloud. Your own lead sheet never leaves this browser." : "Lead names and numbers never leave this browser.");
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
let linkMisses = 0;   // unanswered requests in a row: one is often the phone's Wi-Fi waking up, so it takes two to show "offline"
let recheck = null;

async function phone(op, extra) {
  try {
    const r = await PhoneLink.request(op, extra);
    linkMisses = 0;
    setHealth("ok");
    return r;
  } catch (e) {
    if (e.unreachable && ++linkMisses < 2 && linkHealth === "ok") {
      // First miss while connected: keep showing connected and look again in 3 seconds instead of 15.
      clearTimeout(recheck);
      recheck = setTimeout(checkPhone, 3000);
      throw e;
    }
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
  if (!PhoneLink.isPaired()) return;
  const lead = campOn() ? campLead() : null;
  if (!lead && !sheet) return;
  const mine = (r) => (lead ? r.leadId === lead.id : !r.leadId && r.rowIndex === sheet.idx);
  const open = CallRecords.all()
    .filter((r) => r.saveStatus === "awaiting-outcome" && !CALL_FINAL[r.callStatus] && mine(r))
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
  return !!(live || midScript || state.practice || (campOn() && camp.begun));   // Phase A: caller: save the call first
}
function leaveMessage() {
  if (state.practice) return I18n.t("practice.blocked");
  return campOn() && camp.begun ? I18n.t("camp.saveFirst") : "Finish or restart this call before moving to another lead.";
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
  panel.hidden = !sheet || campOn();   // Phase A: caller: campaign leads are in the waiting list
  if (panel.hidden) return;
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
  campTrackStep();      // Phase A: caller
  renderCampaign();
  renderSheet();
  renderPractice();
  renderCallMode();
  renderHelp();
  const rail = $("rail"); rail.textContent = "";
  rail.hidden = !!node.none;
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
  } else if (node.none) {
    // Phase A: caller. No script steps for this campaign: talk to the lead, then pick the result below.
    card.appendChild(el("span", "label", I18n.t("camp.noScriptTitle")));
    card.appendChild(el("p", "noscript", campHasScripts() ? I18n.t("camp.noScript") : I18n.t("camp.noScriptPlan")));
  } else if (node.end && campOn()) {
    card.appendChild(el("span", "outcome mid", I18n.t("camp.scriptDone", { label: node.end.label })));
    card.appendChild(el("p", "heard", I18n.t("camp.pickBelow")));
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
  const b = el("button", o.hot ? "chip hot" : "chip", o.chip); b.type = "button"; b.id = "obj-" + i;
  b.addEventListener("click", () => { if (!state.objs.includes(o.chip)) state.objs.push(o.chip); state.objection = i; render(); window.scrollTo({ top: 0, behavior: "auto" }); });
  $("chips-" + o.g).appendChild(b);
});
/* ---- Helper column: the questions leads often ask at the step the call has reached ----
   Each script step belongs to a topic, and each topic lists answers by name, from OBJECTIONS or HELP.
   HELP holds answers that only appear here and in search, not in the Pushback and Worries lists. */
const HELP = [
  { g: "help", chip: "Why are you asking?", say: "Just to see if the course suits you. It is mainly for working engineers, but freshers with good Python also join." },
  { g: "help", chip: "I am a fresher, can I join?", say: "Yes, if your Python is good. The course is mainly for working engineers, so you learn with experienced people. Do you know Python?" },
  { g: "help", chip: "I am not in IT, can I join?", say: "Yes, if you can code. You need Python, and we give you Python classes before the batch starts. Do you know any coding?" },
  { g: "help", chip: "I have a career gap, can I join?", say: "Yes. What matters is Python, and time to practise, about 20 hours a week. Do you know Python?" },
  { g: "help", chip: "When do I get the Python classes?", say: "Within 24 hours of joining. So you can finish them before the batch starts on 21 November." },
  { g: "help", chip: "Do I need Docker and Git?", say: "Only the basics. The classes before the batch cover Python, Docker and Git, so you will be ready." },
  { g: "help", chip: "When will I get the recording?", say: "Within 24 hours of each class. And you can watch it for life." },
  { g: "help", chip: "Is there an EMI?", say: "Right now you can pay in two parts. ₹6,000 to join, and the rest within 15 days.", tip: "For anything other than two parts, check with the team first." },
  { g: "help", chip: "When does the batch start?", say: "On 21 November. Registrations close on 11 November." },
];
const ANSWERS = OBJECTIONS.concat(HELP);
const TOPICS = {
  opening: ["What is Vector 2.0?", "Where did you get my number?", "What is TechSimPlus?", "Where are you based? Is it online?"],
  work: ["Why are you asking?", "I am a fresher, can I join?", "I am not in IT, can I join?", "I have a career gap, can I join?"],
  python: ["I do not know Python", "When do I get the Python classes?", "Do I need Docker and Git?"],
  experience: ["No Gen-AI experience", "YouTube is free", "Too basic for me", "Courses are useless"],
  pitch: ["What will I learn?", "What are the five projects?", "Who is the instructor?", "Placement support? Will I get a job?"],
  time: ["When will I get the recording?", "What if I miss a class?", "Can I switch batch?", "How many hours a week?"],
  fee: ["Can I pay in instalments?", "Is there an EMI?", "Can I get a refund?", "Will my company pay?"],
  close: ["When does the batch start?", "Can I see a demo class?", "Need to ask family", "I will join next batch"],
};
const TOPIC_STEPS = {
  opening: "open wrong_person intro intro_maybe ni_soft send_details callback callback_ok i_open i_wrong i_intro i_about exit_wrong exit_dnc",
  work: "q_curriculum curr_yes techcall q_work fresher i_work i_student",
  python: "q_python python_no python_maybe i_python i_python_no i_python_ok",
  experience: "q_genai genai_no burned burned_yes trust q_scale experienced q_goal goal_no goal_no2",
  pitch: "pitch1 trust_brand pitch2 pitch3 diff pitch_no i_pitch i_unsure i_no",
  time: "time time_no time_no2 exit_later i_time i_timeok i_notime",
  fee: "fee fee_maybe fee_no fee_no2 fee_only i_fee",
  close: "close won think followup followup_time followup_n exit_polite exit_notfit i_next i_booked",
};
const TOPIC_OF = {};
Object.keys(TOPIC_STEPS).forEach((t) => TOPIC_STEPS[t].split(" ").forEach((s) => { TOPIC_OF[s] = t; }));
const answerNamed = (name) => ANSWERS.find((a) => a.chip === name);

/* Search: every word typed must appear in the answer (its name, text or tip), or one of its everyday synonyms. */
const SYNONYMS = {
  offer: ["offer", "discount", "20%", "₹5,000"], discount: ["discount", "offer", "20%"],
  emi: ["emi", "instalment", "two parts"], instalment: ["instalment", "emi", "two parts"], installment: ["instalment", "emi", "two parts"],
  fee: ["fee", "₹", "price", "expensive", "pay"], fees: ["fee", "₹", "price", "expensive", "pay"], price: ["fee", "price", "₹", "expensive"], cost: ["cost", "fee", "₹", "price"], money: ["money", "fee", "₹", "refund"],
  recording: ["record", "miss"], record: ["record", "miss"], video: ["record", "video", "youtube"],
  job: ["job", "placement", "hired", "interview"], placement: ["placement", "job", "hired"],
  time: ["time", "hour", "weekday", "weekend", "batch", "timing"], timing: ["time", "weekday", "weekend", "batch"],
  python: ["python", "coding", "code"], code: ["code", "coding", "python"], cloud: ["cloud", "aws", "azure"],
  hindi: ["hindi", "english"], refund: ["refund", "money back"], start: ["start", "21 november", "batch"],
};
function searchAnswers(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return ANSWERS.map((a) => {
    const name = a.chip.toLowerCase(), text = (a.chip + " " + a.say + " " + (a.tip || "")).toLowerCase();
    let score = 0;
    for (const w of words) {
      const alts = own(SYNONYMS, w) || [w];
      if (name.includes(w)) score += 4;   // the word itself in the question ranks first
      else if (alts.some((x) => name.includes(x))) score += 3;
      else if (alts.some((x) => text.includes(x))) score += 1;
      else return null;
    }
    return { a, score };
  }).filter(Boolean).sort((x, y) => y.score - x.score).slice(0, 8).map((r) => r.a);
}

let helpOpen = null;   // the answer shown under its question, by name
let helpNode = null;   // the step the helper column was last drawn for
function helpItems() {
  const q = $("help-search").value.trim();
  if (q) return searchAnswers(q);
  return (TOPICS[TOPIC_OF[state.node]] || []).map(answerNamed).filter(Boolean);
}
function renderHelp() {
  const col = $("help-col");
  col.hidden = ACTIVE !== BUILTIN;   // the answers belong to the built-in script
  if (col.hidden) return;
  if (helpNode !== state.node) { helpNode = state.node; if (!$("help-search").value.trim()) helpOpen = null; }
  const q = $("help-search").value.trim();
  const items = helpItems();
  $("help-title").textContent = q ? (items.length ? "Answers for “" + q + "”" : "No answer for “" + q + "”") : "They may ask now";
  const list = $("help-list"); list.textContent = "";
  if (!items.length && !q) list.appendChild(el("p", "hint", "Press / to search every answer."));
  items.forEach((a) => {
    const item = el("div", "help-item");
    const b = el("button", "help-q", a.chip); b.type = "button";
    b.setAttribute("aria-expanded", String(helpOpen === a.chip));
    b.addEventListener("click", () => {
      helpOpen = helpOpen === a.chip ? null : a.chip;
      if (helpOpen && !state.objs.includes(a.chip)) state.objs.push(a.chip);   // counted as raised, like a tapped button
      renderHelp();
      const again = [...$("help-list").querySelectorAll(".help-q")].find((x) => x.textContent === a.chip);
      if (again) again.focus();
    });
    item.appendChild(b);
    if (helpOpen === a.chip) {
      const ans = el("div", "help-a"); const p = el("p"); fillInto(p, a.say); ans.appendChild(p);
      if (a.tip) ans.appendChild(el("p", "tip", a.tip));
      item.appendChild(ans);
    }
    list.appendChild(item);
  });
  // While searching, the matching Pushback and Worries buttons light up and the others fade.
  const hits = q ? new Set(items.map((a) => a.chip)) : null;
  OBJECTIONS.forEach((o, i) => {
    const c = $("obj-" + i); if (!c) return;
    c.classList.toggle("match", !!hits && hits.has(o.chip));
    c.classList.toggle("dim", !!hits && !hits.has(o.chip));
  });
}
function clearHelpSearch() { $("help-search").value = ""; helpOpen = null; renderHelp(); }
$("help-search").addEventListener("input", () => { helpOpen = null; renderHelp(); });
$("help-search").addEventListener("keydown", (ev) => {
  const items = helpItems();
  if (ev.key === "Escape") { ev.preventDefault(); clearHelpSearch(); ev.target.blur(); }
  else if (ev.key === "Enter" && items.length) { ev.preventDefault(); helpOpen = items[0].chip; if (!state.objs.includes(helpOpen)) state.objs.push(helpOpen); renderHelp(); }
  else if (ev.key === "ArrowDown") { const f = $("help-list").querySelector(".help-q"); if (f) { ev.preventDefault(); f.focus(); } }
});
$("help-list").addEventListener("keydown", (ev) => {
  if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Escape") return;
  ev.preventDefault();
  if (ev.key === "Escape") { $("help-search").focus(); return; }
  const qs = [...$("help-list").querySelectorAll(".help-q")];
  const i = qs.indexOf(document.activeElement);
  if (ev.key === "ArrowUp" && i <= 0) { $("help-search").focus(); return; }
  const next = qs[Math.min(qs.length - 1, Math.max(0, i + (ev.key === "ArrowDown" ? 1 : -1)))];
  if (next) next.focus();
});

$("call-mode").querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setCallMode(b.dataset.mode)));
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
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if ((ev.key === "/" && !typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey) || ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k")) {
    if (!$("help-col").hidden) { ev.preventDefault(); $("help-search").focus(); $("help-search").select(); }
    return;
  }
  if (tag === "INPUT" || tag === "TEXTAREA" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  const map = { "1": "yes", "2": "no", "3": "maybe" };
  if ((ev.key === "ArrowLeft" || ev.key === "ArrowRight") && sheet && !campOn()) {
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
  campOnCloud(Cloud.info());   // Phase A: caller
});
let cloudStatus = "";
Cloud.onChange((c) => {
  refreshLinkPanel();
  if (c.status !== cloudStatus) {
    cloudStatus = c.status;
    if (c.status === "ready") cloudSweep();   // catch up after signing in
    if (appReady) campOnCloud(c);              // Phase A: caller
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

/* ---- Campaign calling (Phase A: caller) ----
   With the cloud on and the caller's seat on a running or paused campaign (my_campaigns()), the page calls cloud
   leads instead of a lead sheet:
   - "Calling for" picks the campaign (remembered in this browser); "My lead sheet" keeps the old page;
   - the waiting leads sit beside the call card: call backs and promises that are due, then new leads
     (js/campaign-queue.js). A "whoever is free next" campaign takes a lead with next_free_lead() when none is waiting;
   - the lead card shows the sheet's extra fields, the amount due (lead_money(), memory only) and the last call;
   - the script is the campaign's own (campaigns.script_id) when the plan has Scripts; otherwise no steps;
   - the result buttons come from the campaign's call type (js/result-buttons.js); "Save and call next" puts the
     result in the outbox in IndexedDB first (js/offline-store.js), then sends it with save_call_result(), now or
     when the connection is back. The time on each script step and the furthest step go with it (js/step-clock.js);
   - "Send on WhatsApp" opens the caller's own WhatsApp with the message filled in (js/wa-link.js).
   With no campaigns, or the cloud off, nothing here shows and the lead sheet works exactly as before. */
const CAMP_KEY = "vca2-campaign";   // the picked campaign id ("" = my lead sheet). A per-browser convenience.

function campOn() { return !!camp.id && Cloud.hasSeat() && camp.list.some((c) => c.campaign_id === camp.id); }
function campCurrent() { return camp.list.find((c) => c.campaign_id === camp.id) || null; }
/* Unknown (an older database, or never loaded): scripts stay on, as before the add-on existed. */
function campHasScripts() { return !Array.isArray(camp.features) || camp.features.includes("scripts"); }
function campPending() { return camp.outbox.filter((i) => i.campaignId === camp.id); }
/* The queue as this device knows it: the server's copy with the results not sent yet laid over it. */
function campView() { return CampaignQueue.withPending(camp.leads, campPending()); }
function campLead() {
  if (!camp.lead) return null;
  return campView().find((l) => l.id === camp.lead.id) || camp.lead;
}
function campResult(key) { const c = campCurrent(); return c && Array.isArray(c.results) ? c.results.find((r) => r.key === key) || null : null; }

function campResetCall() { camp.begun = false; camp.beganAt = 0; camp.clock.reset(); }
/* The call has started (dialled, or the first answer tapped): the call timer and the step clock run. */
function campBegin(at) {
  if (!campOn() || camp.begun || state.practice || !camp.lead) return;
  camp.begun = true; camp.beganAt = at;
  if (ACTIVE !== NO_SCRIPT) camp.clock.enter(state.node, campRank(state.node), at);
  startClock();
  campPresence();
}
/* How far into the script a step is: its stage, then its place in the saved script. */
function campRank(id) {
  const n = FLOW[id];
  const i = ACTIVE.order ? ACTIVE.order.indexOf(id) : -1;
  return ((n && n.stage) || 0) * 1000 + Math.max(0, i);
}
function campTrackStep() {
  if (!campOn() || !camp.begun || state.practice || ACTIVE === NO_SCRIPT) return;
  if (camp.clock.current() !== state.node) camp.clock.enter(state.node, campRank(state.node), Date.now());
}

/* The cloud signed in, went offline or signed out. */
async function campOnCloud(c) {
  if (!c.enabled || !(c.status === "ready" || c.status === "offline") || !c.seatId) {
    if (c.status === "signed_out" || c.status === "no_seat" || c.status === "off") {
      camp.list = []; camp.id = null; camp.lead = null; camp.leads = []; camp.info = null; camp.money = Object.create(null);
      camp.seat = ""; render();
    }
    return;
  }
  if (camp.seat !== c.seatId) {
    camp.seat = c.seatId; camp.lead = null; camp.leads = []; camp.info = null; camp.money = Object.create(null);
    camp.outbox = (await OfflineStore.get(OfflineStore.keys.outbox(c.seatId))) || [];
    camp.failed = (await OfflineStore.get(OfflineStore.keys.failed(c.seatId))) || [];
  }
  await campLoadList();
  campSync();
}

/* Phase A: integration. The practice page link (my_practice) and the institute's approved WhatsApp templates
   (my_whatsapp_templates, through js/whatsapp-client.js). Both are optional: a missing function, no Scripts
   add-on or no connected number just leaves them out. */
async function campLoadExtras() {
  const seat = camp.seat;
  const p = await Cloud.myPractice();
  if (seat !== camp.seat) return;
  camp.practice = !p.error && Array.isArray(p.data) ? p.data : null;
  const client = Cloud.client();
  let list = [];
  if (client && window.VectorWhatsApp) {
    try { list = await window.VectorWhatsApp.loadTemplates(client); } catch (e) { list = []; }
  }
  if (seat !== camp.seat) return;
  camp.waTemplates = Array.isArray(list) ? list : [];
  render();
}

/* The approved template to offer after this result: one for this call type and ending (or any), with no blank
   the caller must type. null when there is none. */
function campWaOffer() {
  const c = campCurrent();
  if (!c || !camp.pick || !camp.waTemplates.length || !window.VectorWhatsApp) return null;
  const W = window.VectorWhatsApp;
  return W.forResult(camp.waTemplates, c.call_type_key, camp.pick).find((t) => !W.typedBlanks(t).length) || null;
}

/* Sends the WhatsApp templates asked for with results the server has now saved (the person's consent is then on
   the lead). The server checks consent, do-not-call, the template and once a day again. */
async function campSendWhatsapp(items) {
  const client = Cloud.client();
  if (!client || !window.VectorWhatsApp) return;
  for (const it of items) {
    if (!it.wa || (it.response && it.response.duplicate)) continue;
    const out = await window.VectorWhatsApp.sendAfterCall(client, it.leadId, it.wa.key);
    note(out && out.ok ? I18n.t("camp.waAppSent", { label: it.wa.label, name: it.leadName })
      : I18n.t("camp.waAppFailed", { name: it.leadName, error: (out && out.error) || "" }));
  }
}

/* Presence for the admin Home tab ("On a call", "Phone offline"): about once a minute, and when a call starts
   or is saved. report_presence is from the admin tabs; an older database without it is left alone. */
let presenceOff = false;
async function campPresence() {
  if (presenceOff || !Cloud.hasSeat() || document.hidden) return;
  const live = callView && (callView.phase === "REQUESTED" || callView.phase === "OFFHOOK");
  const onCall = !!(live || camp.begun);
  const phoneOk = !PhoneLink.isPaired() || linkHealth === "ok" || linkHealth === "checking";
  const r = await Cloud.reportPresence(onCall, phoneOk);
  if (r.error && Cloud.missing(r.error)) presenceOff = true;
}

/* my_campaigns() and my_features(), with the last answer kept for offline use. */
async function campLoadList() {
  const seat = camp.seat;
  const key = OfflineStore.keys.campaigns(seat);
  const [cs, fs] = await Promise.all([Cloud.myCampaigns(), Cloud.myFeatures()]);
  if (seat !== camp.seat) return;
  const cached = (await OfflineStore.get(key)) || {};
  if (!cs.error) camp.list = Array.isArray(cs.data) ? cs.data : [];
  else if (!cs.error.code) camp.list = cached.list || [];   // offline: the campaigns seen last time
  else camp.list = [];                                      // e.g. an older database without campaigns
  if (!fs.error) camp.features = Array.isArray(fs.data) ? fs.data : [];
  else if (!fs.error.code) camp.features = cached.features === undefined ? null : cached.features;
  else camp.features = null;
  if (!cs.error) OfflineStore.set(key, { list: camp.list, features: camp.features });
  campLoadExtras();

  let want = null;
  try { want = localStorage.getItem(CAMP_KEY); } catch (e) {}
  const was = camp.id;
  if (want === "" && camp.list.length) camp.id = "";
  else if (camp.list.some((c) => c.campaign_id === want)) camp.id = want;
  else camp.id = camp.list.length ? camp.list[0].campaign_id : null;
  if (camp.id !== was) { camp.lead = null; camp.leads = []; camp.info = null; }
  if (campOn()) await campRefresh();
  loadPublishedScript();
  render();
  if (campOn()) resumeLastCall();
}

/* "Calling for": a campaign, or "" for my lead sheet. Not while a call is open. */
function campPick(id) {
  if (leaveBlocked()) { note(leaveMessage()); render(); return; }
  try { localStorage.setItem(CAMP_KEY, id); } catch (e) {}
  camp.id = id; camp.lead = null; camp.leads = []; camp.info = null; camp.pick = null; camp.values = {}; camp.msg = "";
  note("");
  resetCall();
  render();
  if (campOn()) campRefresh();
  loadPublishedScript();
}

/* The campaign's script when the plan has Scripts, kept on this device for offline use.
   campaign_script_version(campaign, lead) gives the version for the lead on the card: the published one, or the
   lead's version A or B while a script test runs (so the call counts in the test: script_id and version are saved
   with the result). An older database without that function: the published version (scriptById). */
async function loadCampaignScript(mine) {
  const c = campCurrent();
  const l = camp.lead;
  let got = null;
  if (c && c.script_id && campHasScripts()) {
    const key = "script:" + c.script_id;
    const leadKey = l ? key + ":lead:" + l.id : null;
    const r = await Cloud.campaignScript(c.campaign_id, l ? l.id : null);
    if (!r.error) {
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      got = row && Array.isArray(row.steps) ? { scriptId: row.script_id, version: row.version, steps: row.steps, arm: row.arm || null } : null;
      if (got) OfflineStore.set(got.arm && leadKey ? leadKey : key, got);
    } else if (Cloud.missing(r.error)) {
      got = await Cloud.scriptById(c.script_id);
      if (got) OfflineStore.set(key, got);
      else got = await OfflineStore.get(key);
    } else {
      // Offline, or the lead moved on: what this device saw last, the lead's test version first.
      got = (leadKey && (await OfflineStore.get(leadKey))) || (await OfflineStore.get(key));
    }
  }
  if (mine !== scriptFetch) return;
  const flow = got ? ScriptAdapter.adaptSteps(got.steps) : null;
  if (got && !flow) note(I18n.t("camp.scriptBroken"));
  wanted = flow
    ? { flow: flow, start: ScriptAdapter.startStepId(got.steps), scriptId: got.scriptId, version: got.version, order: got.steps.map((x) => x.id) }
    : NO_SCRIPT;
  useWanted();
  render();
}

/* The caller's queue from the server (my_call_queue), or the copy on this device when offline. */
async function campRefresh(opts) {
  const o = opts || {};
  if (!campOn()) return;
  const id = camp.id, seat = camp.seat;
  const key = OfflineStore.keys.queue(seat, id);
  const res = await Cloud.callQueue(id);
  if (id !== camp.id || seat !== camp.seat) return;
  if (!res.error && res.data) {
    const d = res.data;
    camp.info = { status: d.status, share_mode: d.share_mode, daily_target: d.daily_target, my_calls_today: d.my_calls_today || 0, team_calls_today: d.team_calls_today || 0, at: Date.now() };
    camp.leads = Array.isArray(d.leads) ? d.leads : [];
    camp.offline = false; camp.msg = "";
    Object.keys(camp.money).forEach((k) => { if (camp.money[k] && camp.money[k].offline) delete camp.money[k]; });
    OfflineStore.set(key, { info: camp.info, leads: camp.leads });
  } else {
    const cached = await OfflineStore.get(key);
    if (id !== camp.id) return;
    if (cached) { camp.info = cached.info; camp.leads = cached.leads || []; }
    camp.offline = !res.error || !res.error.code;
    camp.msg = camp.offline ? I18n.t("camp.offline") : I18n.t("camp.loadError", { error: res.error.message || res.error.code });
  }
  await campEnsureLead(o.claim !== false);
  render();
}

/* Keeps the lead on the card while a call is open; otherwise shows the first lead to call. In a "whoever is free
   next" campaign with nothing waiting, asks next_free_lead() for one. */
async function campEnsureLead(claim) {
  const view = campView();
  const now = Date.now();
  if (camp.lead && (camp.begun || state.history.length || camp.pick)) return;
  if (camp.lead && view.some((l) => l.id === camp.lead.id && CampaignQueue.isOpen(l))) return;   // the caller may have picked a later lead
  const next = CampaignQueue.callable(view, now)[0] || null;
  if (next) { campShow(next); return; }
  camp.lead = null;
  if (claim && camp.info && camp.info.share_mode === "next_free" && camp.nextFree && !camp.offline) await campClaimNext();
}

/* next_free_lead(p_campaign) is built with the campaigns feature. Its answer may be a lead id, a lead row or a list
   of rows; without the function the page just keeps the queue it has. */
async function campClaimNext() {
  const id = camp.id;
  const r = await Cloud.nextFreeLead(id);
  if (id !== camp.id) return;
  if (r.error) { if (Cloud.missing(r.error)) camp.nextFree = false; return; }
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  const leadId = typeof row === "string" ? row : row && typeof row === "object" ? row.lead_id || row.id || row.next_free_lead : null;
  if (!leadId) return;
  await campRefresh({ claim: false });
  const got = campView().find((l) => l.id === leadId);
  if (got && !camp.begun) campShow(got);
}

function campShow(lead) {
  const was = camp.lead ? camp.lead.id : null;
  camp.lead = Object.assign({}, lead);
  camp.shownAt = Date.now();
  camp.pick = null; camp.values = {};
  resetCall();
  campMoney(lead.id);
  // A script test gives each lead version A or B: ask again for the lead now on the card.
  const c = campCurrent();
  if (was !== lead.id && c && c.script_id && campHasScripts()) loadPublishedScript();
}
function campGoTo(id) {
  if (camp.lead && camp.lead.id === id) return;
  if (leaveBlocked()) { note(leaveMessage()); return; }
  const l = campView().find((x) => x.id === id);
  if (!l) return;
  note("");
  campShow(l);
  render();
  window.scrollTo({ top: 0, behavior: "auto" });
}

/* The amount due of the lead on the card, from lead_money(). Kept in memory for this page only. */
async function campMoney(leadId) {
  if (camp.money[leadId] !== undefined) return;
  camp.money[leadId] = { loading: true };
  const r = await Cloud.leadMoney(leadId);
  const row = r.error ? null : (Array.isArray(r.data) ? r.data[0] : r.data);
  camp.money[leadId] = r.error ? (r.error.code ? { error: true } : { offline: true }) : (row || { none: true });
  if (camp.lead && camp.lead.id === leadId) renderCampaign();
}

/* ---- Saving ---- */

async function campSave() {
  if (state.practice) { $("res-msg").textContent = I18n.t("practice.blocked"); return; }
  const c = campCurrent(), l = campLead();
  if (!c || !l) return;
  const result = campResult(camp.pick);
  const probs = ResultButtons.problems(result, camp.values);
  if (probs.length) { $("res-msg").textContent = probs.join(" "); return; }
  const now = Date.now();
  const steps = ACTIVE === NO_SCRIPT ? { times: {}, reached: null } : camp.clock.result(now);
  const rec = state.callId ? CallRecords.get(state.callId) : null;
  const id = crypto.randomUUID();
  const v = camp.values;
  const offer = v.waApp && campWaAppShown() ? campWaOffer() : null;
  const item = {
    id: id, seatId: camp.seat, campaignId: c.campaign_id, leadId: l.id, leadName: l.name, label: result.label, savedAt: now,
    wa: offer ? { key: offer.key, label: offer.label || offer.key } : null,   // sent once the server has the result
    callId: rec ? rec.sessionId : null,
    result: { key: result.key, needs_date: !!result.needs_date, needs_amount: !!result.needs_amount },
    values: { date: v.date || "", nextCallAt: ResultButtons.callAt(v.date, v.time), waConsent: v.waConsent, note: String(v.note || "").trim() },
    args: ResultButtons.toArgs(result, v, {
      id: id, leadId: l.id, stepTimes: steps.times, reachedStep: steps.reached,
      scriptStep: ACTIVE === NO_SCRIPT ? null : state.node, scriptId: ACTIVE.scriptId, scriptVersion: ACTIVE.version,
      dialledAt: (rec && rec.dialWallMs) || camp.beganAt || now,
      connectedSeconds: rec ? rec.connectedSeconds : null, phoneSessionId: rec ? rec.sessionId : null,
    }),
  };
  // On this device first: the result is never lost, whatever the network does next.
  camp.outbox = OfflineStore.add(camp.outbox, item);
  await OfflineStore.set(OfflineStore.keys.outbox(camp.seat), camp.outbox);
  if (rec) CallRecords.update(rec.sessionId, { outcome: result.label, outcomeCode: result.key, outcomeAtMs: now, saveStatus: "campaign", notes: item.values.note });
  logEntry("campaign-result", { result: result.key });   // no names or numbers
  const savedId = l.id;
  camp.pick = null; camp.values = {};
  resetCall();
  camp.lead = null;
  const next = CampaignQueue.nextLead(campView(), Date.now(), savedId);
  if (next) campShow(next);
  note(I18n.t("camp.saved", { result: result.label, name: l.name }));
  render();
  window.scrollTo({ top: 0, behavior: "auto" });
  await campSync();
  if (!camp.lead) await campEnsureLead(true);
  render();
  campPresence();
}

/* A laptop call's result waits up to 2 minutes for the phone's call log, so the connected time goes with it. */
function campReady(item) {
  if (!item.callId) return item;
  const rec = CallRecords.get(item.callId);
  if (rec && !CALL_FINAL[rec.callStatus] && Date.now() - item.savedAt < 120000) return null;
  if (!rec) return item;
  const args = Object.assign({}, item.args);
  if (rec.connectedSeconds != null) args.p_connected_seconds = Math.max(0, Math.round(rec.connectedSeconds));
  if (rec.dialWallMs) args.p_dialled_at = new Date(rec.dialWallMs).toISOString();
  return Object.assign({}, item, { args: args });
}

/* Sends the outbox. Items leave it only once the server has them, or refused them (then they are listed). */
async function campSync() {
  // A call while a sync is running (e.g. the "online" event while an offline attempt is still failing) runs
  // once more when that one ends, so it is never lost until the next 30-second retry.
  if (camp.syncing) { camp.syncAgain = true; return; }
  if (!camp.seat || !camp.outbox.length || !Cloud.hasSeat()) return;
  camp.syncing = true; camp.syncAgain = false;
  const seat = camp.seat;
  let r = null;
  try {
    r = await OfflineStore.sync(camp.outbox, [], (it) => Cloud.saveCallResult(it.args), campReady);
    if (seat !== camp.seat) return;
    const done = new Set(r.sent.concat(r.failed).map((x) => x.id));
    camp.outbox = camp.outbox.filter((i) => !done.has(i.id));   // items added while sending stay
    if (r.failed.length) camp.failed = camp.failed.concat(r.failed).slice(-100);
    await OfflineStore.set(OfflineStore.keys.outbox(seat), camp.outbox);
    if (r.failed.length) await OfflineStore.set(OfflineStore.keys.failed(seat), camp.failed);
  } finally { camp.syncing = false; }
  if (r && r.sent.length) campSendWhatsapp(r.sent);
  if (r && (r.sent.length || r.failed.length) && campOn()) await campRefresh({ claim: !camp.lead });
  else renderCampaign();
  if (camp.syncAgain) { camp.syncAgain = false; campSync(); }
}

/* ---- Drawing ---- */

function campDate(at) { return new Date(at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
function todayIsoIndia() { return new Date(Date.now() + 330 * 60e3).toISOString().slice(0, 10); }

/* The practice page link: scripts the caller can practise (my_practice), with the ones an admin asked for. */
function renderPracticeLink() {
  const a = $("practice-link");
  const rows = Cloud.hasSeat() && Array.isArray(camp.practice) ? camp.practice : [];
  a.hidden = !rows.length;
  if (!rows.length) return;
  const todo = rows.filter((x) => x.assignment_id && !x.done_at);
  a.textContent = todo.length ? I18n.t("camp.practiceToDo", { n: todo.length }) : I18n.t("camp.practice");
  a.href = todo.length === 1 ? "practice.html?script=" + encodeURIComponent(todo[0].script_id) : "practice.html";
}

function renderCampaign() {
  const on = campOn();
  const bar = $("camp-bar"), sel = $("camp-pick");
  bar.hidden = !camp.list.length || !Cloud.hasSeat();
  if (!bar.hidden) {
    const opts = camp.list.map((c) => [c.campaign_id, c.name + (c.status === "paused" ? " (paused)" : "") + " · " + I18n.t("camp.due", { n: Number(c.my_leads_due) || 0 })])
      .concat([["", I18n.t("camp.sheetOption")]]);
    const sig = JSON.stringify(opts);
    if (sel.dataset.sig !== sig) {
      sel.textContent = "";
      opts.forEach(([v, t]) => sel.appendChild(new Option(t, v)));
      sel.dataset.sig = sig;
    }
    sel.value = on ? camp.id : "";
    sel.disabled = leaveBlocked();
    sel.title = sel.disabled ? leaveMessage() : "";
  }
  renderPracticeLink();
  document.querySelector(".work").classList.toggle("campaign", on);
  $("sheet-section").hidden = on;
  $("queue-panel").hidden = !on; $("camp-lead").hidden = !on; $("result-panel").hidden = !on;
  const today = $("camp-today");
  today.hidden = !on || !camp.info;
  if (!on) { camp.resultsSig = ""; return; }
  if (camp.info) {
    const mineToday = (camp.info.my_calls_today || 0) + campPending().filter((i) => i.savedAt >= (camp.info.at || 0)).length;
    const team = (camp.info.team_calls_today || 0) + campPending().filter((i) => i.savedAt >= (camp.info.at || 0)).length;
    today.textContent = "";
    today.appendChild(document.createTextNode(I18n.t("camp.today") + " "));
    today.appendChild(el("b", "", String(team)));
    today.appendChild(document.createTextNode(camp.info.daily_target ? " " + I18n.t("camp.ofTarget", { n: camp.info.daily_target }) : " " + I18n.t("camp.calls")));
    today.appendChild(document.createTextNode(" · " + I18n.t("camp.you", { n: mineToday })));
  }
  renderCampLead();
  renderQueue();
  renderResults();
}

function renderCampLead() {
  const box = $("camp-lead");
  box.textContent = "";
  const c = campCurrent(), l = campLead();
  const who = el("div", "who");
  if (!l) {
    who.appendChild(el("span", "label", I18n.t("camp.callingFor") + " " + (c ? c.name : "")));
    who.appendChild(el("strong", "", I18n.t("camp.noLeads")));
    who.appendChild(el("p", "lastcall", camp.msg || I18n.t("camp.noLeadsHint")));
    box.appendChild(who);
    return;
  }
  who.appendChild(el("span", "label", I18n.t("camp.onCall")));
  who.appendChild(el("strong", "", l.name));
  const facts = el("ul", "leadfacts");
  const fact = (k, v, cls) => { const li = el("li", cls || ""); if (k) li.appendChild(el("span", "k", k + ": ")); li.appendChild(document.createTextNode(v)); facts.appendChild(li); return li; };
  fact("", l.phone, "phone");
  CampaignQueue.extraFields(l.extra).forEach(([k, v]) => fact(k, v));
  const m = camp.money[l.id];
  if (m && m.loading) fact(I18n.t("camp.amountDue"), I18n.t("camp.checking"), "money");
  else if (m && m.offline) fact(I18n.t("camp.amountDue"), I18n.t("camp.moneyOffline"), "money");
  else if (m && m.money_hidden) fact(I18n.t("camp.amountDue"), I18n.t("camp.hidden"), "money");
  else if (m && m.amount_due != null) {
    const li = fact(I18n.t("camp.amountDue"), "", "money");
    li.appendChild(el("b", "", WaLink.rupees(m.amount_due)));
  }
  if (m && !m.money_hidden && m.promised_amount != null && l.status === "promised") {
    const li = fact(I18n.t("camp.promised"), "", "money");
    li.appendChild(el("b", "", WaLink.rupees(m.promised_amount)));
    if (l.promised_date) li.appendChild(document.createTextNode(" " + I18n.t("camp.by", { date: campDate(l.promised_date + "T12:00:00+05:30") })));
    li.appendChild(el("span", "reported", " (" + I18n.t("camp.reported") + ")"));
  }
  const st = CampaignQueue.statusOf(l, Date.now());
  fact("", st.label, "whostate");
  who.appendChild(facts);
  if (l.last_called_at) {
    const r = campResult(l.last_result_key);
    const bits = [I18n.t("camp.lastCall", { date: campDate(l.last_called_at) })];
    if (r) bits.push(r.label);
    let text = bits.join(" · ");
    if (l.last_note) text += ": “" + l.last_note + "”";
    who.appendChild(el("p", "lastcall", text));
  }
  box.appendChild(who);
  const calls = callButtons(l.phone, l.name);
  if (calls.childNodes.length) box.appendChild(calls);
}

function renderQueue() {
  const panel = $("queue-panel");
  panel.textContent = "";
  const view = campView();
  const g = CampaignQueue.groups(view, Date.now());
  const total = g.due.length + g.fresh.length;
  const h = el("h2", "", I18n.t("camp.queueTitle", { n: total })); h.id = "queue-title";
  panel.appendChild(h);
  if (camp.offline) panel.appendChild(el("p", "hint", I18n.t("camp.offline")));
  const section = (title, list) => {
    if (!list.length) return;
    panel.appendChild(el("h3", "", title));
    const ol = el("ol", "queuelist");
    list.slice(0, 50).forEach((l) => {
      const li = el("li");
      const b = el("button", "leadrow" + (camp.lead && camp.lead.id === l.id ? " current" : "")); b.type = "button";
      if (camp.lead && camp.lead.id === l.id) b.setAttribute("aria-current", "true");
      b.appendChild(el("strong", "", l.name));
      const extra = CampaignQueue.extraFields(l.extra).slice(0, 2).map((p) => p[1]).join(" · ");
      if (extra) b.appendChild(el("span", "sub", extra));
      const st = CampaignQueue.statusOf(l, Date.now());
      b.appendChild(el("span", "leadstate " + st.kind, st.label));
      b.addEventListener("click", () => campGoTo(l.id));
      li.appendChild(b);
      ol.appendChild(li);
    });
    panel.appendChild(ol);
    if (list.length > 50) panel.appendChild(el("p", "hint queuemore", I18n.t("camp.more", { n: list.length - 50 })));
  };
  section(I18n.t("camp.groupDue"), g.due);
  section(I18n.t("camp.groupNew"), g.fresh);
  section(I18n.t("camp.groupLater"), g.later);
  if (!view.some((l) => CampaignQueue.isOpen(l))) panel.appendChild(el("p", "hint", I18n.t("camp.noLeadsHint")));
  const waiting = camp.outbox.length;
  if (waiting) panel.appendChild(el("p", "outboxline", I18n.t("camp.waiting", { n: waiting })));
  if (camp.failed.length) {
    const last = camp.failed[camp.failed.length - 1];
    panel.appendChild(el("p", "msgline", I18n.t("camp.failed", { n: camp.failed.length, error: last.error || "" })));
  }
}

/* The result buttons and their fields. Drawn again only when the campaign, lead or picked result changes, so
   typing in a field is never interrupted; the WhatsApp link and the message line update in place. */
function renderResults() {
  const panel = $("result-panel");
  const c = campCurrent(), l = campLead();
  const sig = [camp.id, l ? l.id : "", camp.pick, state.practice, I18n.lang(), c ? JSON.stringify(c.results) : ""].join("|");
  if (sig === camp.resultsSig && panel.childNodes.length) { campUpdateActions(); return; }
  camp.resultsSig = sig;
  panel.textContent = "";
  if (!c || !l) return;
  const h = el("h2", "", I18n.t("camp.howEnded")); h.id = "result-title";
  panel.appendChild(h);
  const s = ResultButtons.split(c.results);
  const btn = (r) => {
    const b = el("button", "resbtn " + ResultButtons.tone(r), r.label); b.type = "button"; b.id = "res-" + r.key;
    b.setAttribute("aria-pressed", String(camp.pick === r.key));
    b.addEventListener("click", () => { camp.pick = camp.pick === r.key ? null : r.key; $("res-msg").textContent = ""; renderResults(); const again = $("res-" + r.key); if (again) again.focus(); });
    return b;
  };
  const grid = el("div", "resgrid"); grid.setAttribute("role", "group"); grid.setAttribute("aria-labelledby", "result-title");
  s.main.forEach((r) => grid.appendChild(btn(r)));
  if (s.main.length) panel.appendChild(grid);
  const common = el("div", "rescommon"); common.setAttribute("role", "group"); common.setAttribute("aria-label", I18n.t("camp.otherResults"));
  common.appendChild(el("span", "hint", I18n.t("camp.or")));
  s.common.forEach((r) => common.appendChild(btn(r)));
  panel.appendChild(common);

  const r = campResult(camp.pick);
  if (r) panel.appendChild(campFields(r, l));

  const actions = el("div", "resactions"); actions.id = "res-actions";
  const wa = el("a", "plain", I18n.t("camp.sendWa")); wa.id = "res-wa-send"; wa.target = "_blank"; wa.rel = "noopener";
  wa.addEventListener("click", (ev) => {
    if (!WaLink.hasSender()) return;   // wa.me in a new tab
    ev.preventDefault();
    WaLink.send({ leadId: l.id, phone: l.phone, text: campWaText() }).then(() => { $("res-msg").textContent = I18n.t("camp.waSent"); }, (e) => { $("res-msg").textContent = e.message; });
  });
  actions.appendChild(wa);
  actions.appendChild(el("span", "hint", "")).id = "res-wa-hint";
  // In-app WhatsApp from the institute's number (connected in Settings), next to the wa.me link.
  const waApp = el("label", "wa-app"); waApp.id = "res-wa-app-row"; waApp.hidden = true;
  const waBox = el("input"); waBox.type = "checkbox"; waBox.id = "res-wa-app"; waBox.checked = !!camp.values.waApp;
  waBox.addEventListener("change", () => { camp.values.waApp = waBox.checked; });
  waApp.appendChild(waBox);
  waApp.appendChild(el("span", "", "")).id = "res-wa-app-label";
  actions.appendChild(waApp);
  const save = el("button", "primary", I18n.t("camp.saveNext")); save.type = "button"; save.id = "res-save";
  save.addEventListener("click", campSave);
  actions.appendChild(save);
  panel.appendChild(actions);
  const msg = el("p", "msgline"); msg.id = "res-msg"; msg.setAttribute("role", "status");
  panel.appendChild(msg);
  campUpdateActions();
}

function campFields(r, l) {
  const box = el("div", "resfields");
  const v = camp.values;
  const field = (labelText, input, wide) => {
    const lab = el("label", "field" + (wide ? " wide" : ""));
    lab.appendChild(el("span", "label", labelText));
    lab.appendChild(input);
    box.appendChild(lab);
    return input;
  };
  const input = (id, type, value, onInput) => {
    const i = el("input"); i.id = id; i.type = type; i.value = value || ""; i.autocomplete = "off";
    i.addEventListener("input", () => { onInput(i.value); campUpdateActions(); });
    return i;
  };
  if (r.needs_date) {
    const d = input("res-date", "date", v.date, (x) => { v.date = x; });
    d.min = todayIsoIndia();
    field(r.needs_amount ? I18n.t("camp.promisedDate") : r.key === "call_back_later" ? I18n.t("camp.callBackOn") : I18n.t("camp.date"), d);
    if (r.key === "call_back_later") field(I18n.t("camp.timeOptional"), input("res-time", "time", v.time, (x) => { v.time = x; }));
  }
  if (r.needs_amount) {
    const a = input("res-amount", "text", v.amount, (x) => { v.amount = x; });
    a.inputMode = "decimal";
    const m = camp.money[l.id];
    if (m && m.amount_due != null) a.placeholder = WaLink.rupees(m.amount_due).replace("₹", "");
    field(r.needs_date ? I18n.t("camp.amount") : I18n.t("camp.amountPaid"), a);
  }
  if (r.needs_reason || (r.reason_choices && r.reason_choices.length)) {
    let ri;
    if (Array.isArray(r.reason_choices) && r.reason_choices.length) {
      ri = el("select"); ri.id = "res-reason";
      ri.appendChild(new Option(I18n.t("camp.pickReason"), ""));
      r.reason_choices.forEach((x) => ri.appendChild(new Option(x, x)));
      ri.value = v.reason || "";
      ri.addEventListener("change", () => { v.reason = ri.value; campUpdateActions(); });
    } else {
      ri = input("res-reason", "text", v.reason, (x) => { v.reason = x; });
      ri.maxLength = 300;
    }
    field(I18n.t("camp.reason"), ri, true);
  }
  if (r.needs_rating) {
    const fs = el("fieldset", "rating");
    fs.appendChild(el("legend", "label", I18n.t("camp.rating")));
    [1, 2, 3, 4, 5].forEach((n) => {
      const lab = el("label");
      const i = el("input"); i.type = "radio"; i.name = "res-rating"; i.value = String(n); i.id = "res-rating-" + n;
      i.checked = String(v.rating) === String(n);
      i.addEventListener("change", () => { v.rating = n; campUpdateActions(); });
      lab.appendChild(i);
      lab.appendChild(el("span", "", String(n)));
      lab.setAttribute("aria-label", I18n.t("camp.ratingOf", { n: n }));
      fs.appendChild(lab);
    });
    box.appendChild(fs);
  }
  const note = input("res-note", "text", v.note, (x) => { v.note = x; });
  note.maxLength = 300; note.placeholder = I18n.t("camp.notePlaceholder");
  field(I18n.t("camp.note"), note, true);
  const wa = el("select"); wa.id = "res-wa";
  [["", I18n.t("camp.waNotAsked")], ["yes", I18n.t("camp.waYes")], ["no", I18n.t("camp.waNo")]].forEach(([val, t]) => wa.appendChild(new Option(t, val)));
  wa.value = v.waConsent === true ? "yes" : v.waConsent === false ? "no" : "";
  wa.addEventListener("change", () => { v.waConsent = wa.value === "yes" ? true : wa.value === "no" ? false : undefined; campUpdateActions(); });
  field(I18n.t("camp.waConsent"), wa);
  return box;
}

function campWaText() {
  const l = campLead(), c = campCurrent(), r = campResult(camp.pick);
  const v = camp.values;
  return WaLink.message({ key: r ? r.key : "", name: l ? l.name : "", me: $("me-name").value, campaign: c ? c.name : "",
    date: v.date, amount: r && r.needs_amount ? ResultButtons.parseAmount(v.amount) : null });
}

/* The institute's-number option shows only when the person said yes (on this call or before) and may be messaged. */
function campWaAppShown() {
  const l = campLead();
  if (!l || state.practice) return false;
  const consent = camp.values.waConsent === true ? "yes" : camp.values.waConsent === false ? "no" : "";
  if (!WaLink.allowed(l, consent, camp.pick)) return false;
  return camp.values.waConsent === true || (camp.values.waConsent !== false && l.consent_whatsapp === true);
}

/* The WhatsApp link, its consent note and the save button, kept in step with the fields. */
function campUpdateActions() {
  const wa = $("res-wa-send"), hint = $("res-wa-hint"), save = $("res-save");
  if (!wa || !save) return;
  const l = campLead();
  const consent = camp.values.waConsent === true ? "yes" : camp.values.waConsent === false ? "no" : "";
  const ok = !!l && WaLink.allowed(l, consent, camp.pick) && !state.practice;
  const href = ok ? WaLink.link(l.phone, campWaText()) : "";
  wa.hidden = !href;
  if (href) wa.href = href; else wa.removeAttribute("href");
  hint.hidden = !href || !WaLink.needsAsking(l, consent);
  hint.textContent = I18n.t("camp.waAsk");
  const appRow = $("res-wa-app-row");
  if (appRow) {
    const offer = campWaAppShown() ? campWaOffer() : null;
    appRow.hidden = !offer;
    if (offer) $("res-wa-app-label").textContent = I18n.t("camp.waApp", { label: offer.label || offer.key });
  }
  save.disabled = !camp.pick || state.practice;
  save.title = state.practice ? I18n.t("practice.blocked") : !camp.pick ? I18n.t("camp.pickFirst") : "";
}

$("camp-pick").addEventListener("change", (ev) => campPick(ev.target.value));
window.addEventListener("online", () => { campSync(); if (campOn()) campRefresh(); });
setInterval(campSync, 30000);
setInterval(campPresence, 60000);   // Phase A: integration (admin Home "callers right now")
setInterval(() => { if (campOn() && !document.hidden && !camp.begun && !camp.pick) campRefresh(); }, 60000);
