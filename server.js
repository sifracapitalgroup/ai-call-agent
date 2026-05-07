require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");

// 👉 ADD THIS HERE
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const app = express();
const server = http.createServer(app);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

let currentCallLead = {};
let callNotesBySid = {};

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY in .env");
}

const wss = new WebSocket.Server({
  server,
  path: "/media-stream",
});

const SYSTEM_PROMPT = `
You are Daniel, a real estate investor calling property owners.

Speak like a real operator — calm, direct, controlled, and natural.

Do NOT sound scripted.
Do NOT overtalk.
Do NOT explain things in detail.
Do NOT rush your speech.

Use short sentences.
Use natural pauses.
Let the seller speak.

--------------------------------------------------

PRIMARY GOAL

Guide the seller to:
- openness to selling
- share condition, timeline, and price
- feel understood and not pressured

You are not pitching.
You are diagnosing and guiding.

--------------------------------------------------

LANGUAGE RULE

You must speak ONLY in English.
Do NOT switch languages under any circumstance.

--------------------------------------------------

TONE + DELIVERY RULES

- Slightly curious tone at the start
- Slow down when seller shares anything personal
- Match their energy (short vs talkative)
- Use light, natural fillers occasionally (“yeah…”, “got it…”)
- NEVER stack questions
- ALWAYS pause after key lines (~1–2 seconds)
- Avoid monotone delivery

----------------------------------

ENERGY + PERSONALITY LAYER

You bring slightly more positive energy into the conversation.

- Your tone has light enthusiasm
- You sound engaged, not flat
- You have subtle personality in your voice
- You are pleasant and easy to talk to

Do NOT sound overly excited.
Do NOT sound like a salesperson.
Do NOT force energy.

Your energy level is:
- +20% more positive than neutral
- calm but upbeat
- confident but relaxed

Slightly smile in your voice when speaking.

--------------------------------------------------

CONVERSATION RHYTHM

Do NOT repeat or rephrase everything the seller says.

Most of the time:

briefly acknowledge
then continue naturally

Only reflect back information when:

the seller shares emotion
motivation
frustration
a meaningful life situation

Keep the conversation moving.

Do NOT slow the flow down with excessive mirroring.
--------------------------------------------------

EMOTIONAL PRIORITY RULE (CRITICAL)

If the seller shares anything personal, emotional, or situational:

- STOP progressing the script
- Acknowledge it
- Validate it
- Stay in that moment briefly

Do NOT say:
“let’s bring it back”
“anyway”
“so…”

Do NOT redirect immediately.

Only continue after the seller feels understood.

--------------------------------------------------

CALL FLOW (FOLLOW NATURALLY, NOT ROBOTICALLY)

OPEN

Hey (Name)?


This is Daniel.


I was calling about your place on (Street in City)…


Would you potentially be open to selling?

--------------------------------------------------

IF SELLER IS OPEN

Got it…
[pause]

Help me understand the property a bit—

--------------------------------------------------

IF SELLER SAYS NO / PUSHBACK

Got it…
[pause]

Sounds like you’re not really looking right now?
[pause]

I mean—if someone came in with a million-dollar offer… you’d at least take a look, right?
[pause]

Once they agree:

Right—so there is a number that would make sense
[pause]

That’s all I’m trying to figure out
[pause]

Give me like 30 seconds—let me just understand the property real quick

--------------------------------------------------

PROPERTY INFO (NO PRIOR DATA)

Remind me—how many beds and baths is it?
[pause]

Square footage?
[pause]

Got it—so (repeat back beds/baths/sqft briefly)

--------------------------------------------------

CONDITION

And how’s the condition overall?
[pause]

Give me the reality of it—
[pause]

million-dollar listing is a 10, full teardown is a 1… where does it sit?

--------------------------------------------------

PROPERTY USE

Was that something you ever rented out, or was it more just yours?

--------------------------------------------------

MOTIVATION

Got it…
[pause]

In a perfect world, whats your ideal scenario with this property?

--------------------------------------------------

RESPONSE LOOP (USE ONLY WHEN MEANINGFUL)

When seller shares something important:

Yeah…
So it’s more about (summarize their situation)…
That makes sense

Then continue naturally.

--------------------------------------------------

TIMELINE

If everything lined up… whats your ideal timeframe in regards to closing?

If unclear:
Is that more like 30 days, or closer to a couple months?

--------------------------------------------------

PRICE

Do you have a number in mind where it would make sense for you?

If hesitant:
Doesn’t have to be exact—just ballpark

If high:
Got it—I hear you. Just trying to understand where you’re at

--------------------------------------------------

POSITIONING (NON-SALESY)

Yeah—usually when I do these, I just keep it straightforward…

--------------------------------------------------

SOFT CLOSE

What I can do is take a look at it and see what actually makes sense
If it lines up, we can go from there—fair?

--------------------------------------------------

EXIT

Alright—I’ll take a look and get back to you
Appreciate you sharing that

--------------------------------------------------

CRITICAL RULES

- NEVER say “in regards to”
- NEVER say “confirm” or “verify”
- NEVER sound like a script
- NEVER argue with the seller
- NEVER push hard on price early

--------------------------------------------------

CONVERSATION CONTROL RULES

- Guide, don’t force
- If seller goes off topic → acknowledge, then gently bring back
- Do NOT say “let’s bring it back”
- Instead:
  “Yeah I hear you…” → then redirect with a question

--------------------------------------------------

FINAL OPERATING MODE

You operate using:

- tonality (calm, controlled, natural delivery)
- understanding (you listen and reflect before moving forward)
- empathy (the seller feels heard and respected)
- subtle psychology (you guide the conversation without pressure)

You are not trying to convince.

You are creating an environment where the seller:
- opens up
- feels comfortable
- shares real information

--------------------------------------------------

SELLER EXPERIENCE TARGET

The seller should feel:

- “this guy actually gets it”
- “he’s not pushing me”
- “this feels easy to talk through”

Not:
- pressured
- rushed
- sold

--------------------------------------------------

YOUR ROLE

You are:

- calm under control
- slightly curious
- easy to talk to
- leading without force

You are NOT:

- aggressive
- robotic
- overly friendly
- overly analytical

--------------------------------------------------

CORE EXECUTION TRUTH

The deal does not come from:
- the script
- the questions

It comes from:
- how the seller feels while talking to you

If they feel understood → they give real answers
If they feel pressure → they shut down
`;


function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  }

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;

  return `${proto}://${host}`;
}

app.get("/", (req, res) => {
  res.status(200).send("Realtime phone agent is running.");
});

app.get("/call-notes/:callSid", (req, res) => {
  const notes = callNotesBySid[req.params.callSid];

  if (!notes) {
    return res.status(404).json({
      success: false,
      error: "No notes found for this Call SID",
    });
  }

  res.json({
    success: true,
    callSid: req.params.callSid,
    notes,
  });
});

app.all("/voice", (req, res) => {
  const publicBaseUrl = getPublicBaseUrl(req);
  const wsUrl = publicBaseUrl.replace(/^http/i, "ws") + "/media-stream";

  console.log("VOICE HIT:", wsUrl);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

async function updateGHL(outcome, summary, phoneOverride) {
  try {
    const response = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        locationId: process.env.GHL_LOCATION_ID,
        phone: phoneOverride,
        customFields: [
          {
            key: "ai_call_outcome",
            field_value: outcome,
          },
          {
            key: "call_notes",
            field_value: summary,
          },
        ],
      }),
    });

    const data = await response.json();
    console.log("GHL UPDATED:", data);
  } catch (err) {
    console.error("GHL UPDATE ERROR:", err);
  }
}

app.post("/call-status", async (req, res) => {
  try {
    console.log("CALL STATUS:", req.body);

const callStatus = req.body.CallStatus;
const callDuration = Number(req.body.Duration || req.body.CallDuration || 0);
const phone = req.body.To || req.body.Called;

console.log("PHONE FROM TWILIO:", phone);
console.log("CALL DURATION USED:", callDuration);

if (
  callStatus === "no-answer" ||
  callStatus === "busy" ||
  callStatus === "failed"
) {
  console.log("TRIGGERING GHL UPDATE FOR NO ANSWER");

  await updateGHL(
    "no_answer_voicemail",
    `Call ended with status: ${callStatus} and duration ${callDuration} seconds.`,
    phone
  );
}

    res.sendStatus(200);
  } catch (err) {
    console.error("CALL STATUS ERROR:", err);
    res.sendStatus(500);
  }
});


app.post("/recording", (req, res) => {
  const recordingUrl = req.body.RecordingUrl + ".mp3";

  console.log("Recording ready:", recordingUrl);
  console.log("Call SID:", req.body.CallSid);

  res.sendStatus(200);
});

app.post("/start-call", async (req, res) => {
  try {
    const {
      first_name,
      last_name,
      phone,
      property_address,
      streetAddress,
      address,
      city,
      state,
      postal_code,
      bed,
      bath,
      sq_ft,
      estimated_value,
      year_built,
      sale_price,
      last_sold,
      call_notes,
    } = req.body;

    const cleanPhone = String(phone || "").trim();

    currentCallLead = {
      first_name:
  first_name ||
  full_name?.split(" ")[0] ||
  name?.split(" ")[0] ||
  "there",
      last_name: last_name || "",
      phone: cleanPhone,
      address:
  property_address ||
  req.body["Property Address"] ||
  address ||
  streetAddress ||
  "your property",
      city: city || "",
      state: state || "",
      postal_code: postal_code || "",
      bed: bed || "",
      bath: bath || "",
      sq_ft: sq_ft || "",
      estimated_value: estimated_value || "",
      year_built: year_built || "",
      sale_price: sale_price || "",
      last_sold: last_sold || "",
      call_notes: call_notes || "",
    };

    console.log("GHL WEBHOOK HIT:", currentCallLead);

    if (!cleanPhone) {
      return res.status(400).json({
        success: false,
        error: "Missing phone number",
      });
    }

    const publicBaseUrl =
      process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ||
      `https://${req.headers.host}`;

    const call = await twilioClient.calls.create({
  to: cleanPhone,
  from: process.env.TWILIO_PHONE_NUMBER,
  url: `${publicBaseUrl}/voice`,
  statusCallback: `${publicBaseUrl}/call-status`,
  statusCallbackEvent: ["completed", "no-answer", "busy",  "failed"],
  record: true,
  recordingChannels: "dual",
  recordingStatusCallback: `${publicBaseUrl}/recording`,
  recordingStatusCallbackEvent: ["completed"],
});

    console.log("OUTBOUND CALL STARTED:", call.sid);

    res.status(200).json({
      success: true,
      message: "Call started",
      callSid: call.sid,
    });
  } catch (err) {
    console.error("START CALL ERROR:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

wss.on("connection", (twilioWs) => {
  console.log("Twilio websocket connected");



function normalizeAddressForSpeech(address) {
  if (!address) return "";

  return address
    .replace(/\bDr\b/gi, "Drive")
    .replace(/\bRd\b/gi, "Road")
    .replace(/\bSt\b/gi, "Street")
    .replace(/\bAve\b/gi, "Avenue")
    .replace(/\bBlvd\b/gi, "Boulevard")
    .replace(/\bLn\b/gi, "Lane")
    .replace(/\bCt\b/gi, "Court")
    .replace(/\bPl\b/gi, "Place")
    .replace(/\bTer\b/gi, "Terrace");
}

  let streamSid = null;
  let callSid = null;
  let latestMediaTimestamp = 0;
  let responseStartTimestamp = null;
  let lastAssistantItem = null;
  let assistantTranscript = "";
  let fullCallTranscript = "";
  let callEndingScheduled = false;
  let leadFirst_name = currentCallLead.first_name || "there";
  let leadAddress = normalizeAddressForSpeech(
  (currentCallLead.address || "your property")
    .replace(/^\d+\s*/, "")
    .replace(/\d{5}(-\d{4})?$/, "")
    .split(",")[0]
    .trim()
);

if (currentCallLead.city) {
  leadAddress += ` in ${currentCallLead.city}`;
}
  let leadCity = currentCallLead.city || "";
  


  const openAiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

 function shouldEndCall(text) {
  const t = String(text || "").toLowerCase();

  const hardGoodbye =
    t.includes("have a good one") ||
    t.includes("have a good day") ||
    t.includes("talk soon") ||
    t.includes("take care") ||
    t.includes("bye");

  const clearClose =
    t.includes("i’ll give you a call back") ||
    t.includes("i’ll follow up with you") ||
    t.includes("i’ll circle back with you");

  return hardGoodbye || clearClose;
}

async function classifyCall(transcript) {
  try {
  if (!transcript || transcript.trim().length < 10) {
  return {
    ai_call_outcome: "no_answer_voicemail",
    call_summary: "No answer or voicemail reached.",
  };
}

const lowerTranscript = transcript.toLowerCase();

const rejectionPhrases = [
  "not interested",
  "no thanks",
  "i'm good",
  "im good",
  "stop calling",
  "remove me",
  "take me off",
  "don't call",
  "do not call",
  "not selling",
  "already sold",
];

if (rejectionPhrases.some((phrase) => lowerTranscript.includes(phrase))) {
  return {
    ai_call_outcome: "not_interested",
    call_summary: "Seller clearly rejected the call or said they are not interested.",
  };
}
    
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `
You classify real estate seller calls.

Return ONLY valid JSON with:
{
  "ai_call_outcome": "no_answer_voicemail | follow_up | interested | not_interested",
  "call_summary": "short summary"
}

Rules:
- no_answer_voicemail = no meaningful conversation, voicemail, no answer, immediate hangup
- interested = seller is open to selling, gives price/timeline/condition, wants an offer, asks for next steps
- not_interested = ANY clear rejection, including:
  "not interested"
  "stop calling"
  "remove me"
  "already sold"
  "take me off your list"
- follow_up = seller is unsure, says maybe later, asks to call back, needs time, or conversation is unclear

CRITICAL:
If the seller says "not interested" return "not_interested".

If uncertain, choose follow_up.
`,
          },
          {
            role: "user",
            content: transcript,
          },
        ],
      }),
    });

    const data = await response.json();
    const parsed = JSON.parse(data.choices[0].message.content);

    const allowed = [
      "no_answer_voicemail",
      "follow_up",
      "interested",
      "not_interested",
    ];

    if (!allowed.includes(parsed.ai_call_outcome)) {
      parsed.ai_call_outcome = "follow_up";
    }

    return parsed;
  } catch (err) {
    console.error("CLASSIFY CALL ERROR:", err);

    return {
      ai_call_outcome: "follow_up",
      call_summary: "Call ended, but classification failed.",
    };
  }
}

function scheduleEndCall(reason) {
  if (callEndingScheduled) return;
  callEndingScheduled = true;

  console.log("AUTO ENDING CALL:", reason);

  setTimeout(async () => {
    try {
      if (callSid) {
        console.log("FORCE END CALL:", callSid);

        twilioClient.calls(callSid).update({
  status: "completed"
});
      }
    } catch (err) {
      console.error("FORCE END CALL ERROR:", err);
    }
  }, 1500);
}

 async function sendSessionUpdate() {
  const leadContext = `
CURRENT LEAD CONTEXT:

You are calling:
Name: ${currentCallLead.first_name || ""} ${currentCallLead.last_name || ""}
Property Address: ${currentCallLead.address || ""}
City: ${currentCallLead.city || ""}
State: ${currentCallLead.state || ""}
Zip Code: ${currentCallLead.zip || ""}
Estimated Value: ${currentCallLead.estimatedValue || ""}
Sq Ft: ${currentCallLead.sqft || ""}
Bed: ${currentCallLead.bed || ""}
Bath: ${currentCallLead.bath || ""}
Year Built: ${currentCallLead.yearBuilt || ""}
Sale Price: ${currentCallLead.sale_price || ""}
Last Sold: ${currentCallLead.lastSold || ""}
Call Notes: ${currentCallLead.callNotes || ""}

Use this as background context.
Do NOT read all details out loud.
Mention the property address naturally.
Do not sound creepy or like you're reading from a database.
Use the data only to guide better questions.
`;

  console.log("CALL LEAD LOADED FROM GHL:", currentCallLead);

  const sessionUpdate = {
    type: "session.update",
    session: {
      turn_detection: {
        type: "server_vad",
        threshold: 0.97,
        prefix_padding_ms: 700,
        silence_duration_ms: 1050,
      },
      input_audio_format: "g711_ulaw",
      input_audio_transcription: {
      model: "gpt-4o-mini-transcribe",
    },

      instructions: SYSTEM_PROMPT + `

CRITICAL EXECUTION RULE:

- LESS is MORE, direct sentences
- Follow the call flow tightly
- One question at a time
If a sentence can be shorter, make it shorter. 

` + leadContext,
      modalities: ["text"],
      temperature: 0.60,
    },
  };

  openAiWs.send(JSON.stringify(sessionUpdate));
}

  function clearTwilioAudio() {
    if (!streamSid) return;

    twilioWs.send(
      JSON.stringify({
        event: "clear",
        streamSid,
      })
    );
  }

 function interruptAssistant() {

  // DO NOT interrupt during opener
  if (openingMessageActive) {
    console.log("IGNORING INTERRUPTION DURING OPENER");
    return;
  }

  if (!lastAssistantItem || responseStartTimestamp === null) return;

  const elapsedMs = latestMediaTimestamp - responseStartTimestamp;

  openAiWs.send(
    JSON.stringify({
      type: "conversation.item.truncate",
      item_id: lastAssistantItem,
      content_index: 0,
      audio_end_ms: elapsedMs,
    })
  );

  clearTwilioAudio();

  lastAssistantItem = null;
  responseStartTimestamp = null;
}

openAiWs.on("open", async () => {
  console.log("Connected to OpenAI Realtime");

  await sendSessionUpdate();

  openAiWs.send(
    JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["text"],
        instructions: `
Say exactly this. No extra words. No filler. No hesitation.

Do NOT say "uh", "um", or any filler.

Speak clean, direct, and confident.

Opening:

Hey ${leadFirst_name}?

.....

This is Daniel.

I'm calling in regards to ${leadAddress} - Would you potentially be open to selling?

`
      },
    })
  );
});

async function speakWithElevenLabs(text) {
  try {
    console.log("ELEVEN START:", text);

    if (!text) {
      console.log("ELEVEN STOP: no text");
      return;
    }

    if (!streamSid) {
      console.log("ELEVEN STOP: no streamSid");
      return;
    }

    const voiceId = process.env.ELEVENLABS_VOICE_ID;

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_flash_v2_5",
          voice_settings: {
            stability: 0.35,
            similarity_boost: 0.85,
            style: 0.35,
            use_speaker_boost: true,
          },
        }),
      }
    );

    console.log("ELEVEN STATUS:", response.status);

    if (!response.ok) {
      console.error("ELEVEN ERROR:", await response.text());
      return;
    }

    const arrayBuffer = await response.arrayBuffer();
    console.log("ELEVEN AUDIO BYTES:", arrayBuffer.byteLength);

    const base64Audio = Buffer.from(arrayBuffer).toString("base64");

    twilioWs.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: {
          payload: base64Audio,
        },
      })
    );

    console.log("ELEVEN SENT TO TWILIO");
  } catch (err) {
    console.error("ELEVEN FUNCTION ERROR:", err);
  }
}
// ✅ THEN this
let assistantText = "";
let fullTranscript = ""; 
let sellerSpoke = false;
let openingMessageActive = false;
let wrongNumberDetected = false;

// ✅ THEN your OpenAI handler


openAiWs.on("message", (data) => {
  try {
    const event = JSON.parse(data.toString());
    console.log("OPENAI EVENT:", event.type);

    if (event.type === "conversation.item.created") {
      const item = event.item;

      if (item?.type === "message" && item.role === "user") {
        const userText = item.content?.[0]?.transcript?.trim();

        if (userText) {
          console.log("USER SAID:", userText);
          fullCallTranscript += `USER: ${userText}\n`;
        }
      }
    }


if (event.type === "conversation.item.input_audio_transcription.completed") {

  sellerSpoke = true;

  const transcript = (event.transcript || "").trim();
  const lowerTranscript = transcript.toLowerCase();

  console.log("SELLER SAID:", transcript);

  // =========================
  // VOICEMAIL DETECTION
  // =========================

  const voicemailPhrases = [
    "your call has been forwarded",
    "automatic voice message system",
    "please leave a message",
    "record your message",
    "at the tone",
    "mailbox is full",
    "google voice subscriber",
    "is not available",
    "can't take your call",
    "leave your name and number",
    "voice mailbox",
    "voicemail"
  ];

  const isVoicemail = voicemailPhrases.some(phrase =>
    lowerTranscript.includes(phrase)
  );

  if (isVoicemail) {

  console.log("VOICEMAIL DETECTED");

  fullTranscript += `\nVOICEMAIL: ${transcript}`;
  fullCallTranscript += `VOICEMAIL: ${transcript}\n`;

  // STOP OPENAI RESPONSE
  openAiWs.send(JSON.stringify({
    type: "response.cancel"
  }));

  // CLEAR ANY AUDIO
  clearTwilioAudio();

  // END CALL IMMEDIATELY
  try {

    await twilioClient.calls(callSid).update({
      status: "completed"
    });

    console.log("VOICEMAIL CALL ENDED");

  } catch (err) {

    console.error("FAILED TO END VOICEMAIL CALL:", err);

  }

  return;
}

    // =========================
  // WRONG NUMBER DETECTION
  // =========================

  const wrongNumberPhrases = [
    "wrong number",
    "you have the wrong number",
    "wrong person",
    "not the right number",
    "you called the wrong number",
    "doesn't live here",
    "does not live here",
    "not this person",
    "you got the wrong person"
  ];

  const isWrongNumber = wrongNumberPhrases.some(phrase =>
    lowerTranscript.includes(phrase)
  );

  if (isWrongNumber) {
    console.log("WRONG NUMBER DETECTED");

    wrongNumberDetected = true;

    fullTranscript += `\nWRONG NUMBER: ${transcript}`;
    fullCallTranscript += `WRONG NUMBER: ${transcript}\n`;

    updateGHL(
      "ai_wrong_number",
      "Contact stated this is a wrong number.",
      currentCallLead.phone
    );

    clearTwilioAudio();

    scheduleEndCall("wrong number");

    return;
  }
  
  // =========================
  // NORMAL HUMAN SPEECH
  // =========================

 fullTranscript += `\nSeller: ${transcript}`;
fullCallTranscript += `SELLER: ${transcript}\n`;

}


    // collect AI streaming text
    if (event.type === "response.text.delta" && event.delta) {
      assistantText += event.delta;
    }

// full message finished
if (event.type === "response.text.done") {
  console.log("AI SAID:", assistantText);


  fullTranscript += `\nAI: ${assistantText}`;
  fullCallTranscript += `AI: ${assistantText}\n`;

  speakWithElevenLabs(assistantText);

console.log("CHECKING END CALL:", assistantText);

if (shouldEndCall(assistantText)) {
  console.log("END CALL TRIGGERED"); // 👈 add this
  scheduleEndCall(assistantText);
}

  assistantText = "";
}

    // user starts speaking → stop any current playback
if (event.type === "input_audio_buffer.speech_started") {
  console.log("Possible user speech detected");

 interruptAssistant();

  setTimeout(() => {
    clearTwilioAudio();
  }, 450);
}

    // safety: end-call checks
    if (event.type === "response.done") {
      const text = JSON.stringify(event);

      if (shouldEndCall(text)) {
        scheduleEndCall(text);
      }

      responseStartTimestamp = null;
      lastAssistantItem = null;
    }

    if (event.type === "error") {
      console.error("OpenAI realtime error:", event);
    }
  } catch (err) {
    console.error("OpenAI message parse error:", err);
  }
});

 twilioWs.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;

        console.log("Twilio stream started:", {
          streamSid,
          callSid,
        });

     

        return;
      }

      if (msg.event === "media") {
        latestMediaTimestamp = msg.media.timestamp;

        if (openAiWs.readyState === WebSocket.OPEN) {
          openAiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: msg.media.payload,
            })
          );
        }

        return;
      }

     if (msg.event === "stop") {
  console.log("Twilio stream stopped:", {
    streamSid,
    callSid,
  });





  if (callSid) {
    const summaryPrompt = `
Summarize this real estate call in ONE short line.

Interest level MUST be one of:
- interested
- not interested
- follow up
- no answer

Format exactly like this:
interest: [one of the four], condition: [if mentioned], timeline: [if mentioned], price: [if mentioned]

Keep it very short. No extra words.

Call:
${fullCallTranscript}
`;

    let summary = "";

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Only output the formatted call summary line." },
            { role: "user", content: summaryPrompt },
          ],
        }),
      });

      const data = await res.json();
      summary = data.choices?.[0]?.message?.content || "";
    } catch (err) {
      console.error("Summary error:", err);
    }

    callNotesBySid[callSid] = {
      summary,
      transcript: fullCallTranscript,
      endedAt: new Date().toISOString(),
    };

    console.log("CALL SUMMARY:", summary);
  }

if (wrongNumberDetected) {
  console.log("Skipping final classification because wrong number was already detected.");
} else if (!sellerSpoke) {
updateGHL(
  "no_answer_voicemail",
  "No answer or voicemail reached. No meaningful seller response.",
  currentCallLead.phone
);
} else if (!fullTranscript || fullTranscript.length < 10) {
updateGHL(
  "follow_up",
  "Seller answered but hung up before a full conversation.",
  currentCallLead.phone
);
} else {
  classifyCall(fullTranscript).then((result) => {
updateGHL(result.ai_call_outcome, result.call_summary, currentCallLead.phone);
  });
}


  if (openAiWs.readyState === WebSocket.OPEN) {
    openAiWs.close();
  }

  return;
}
  } catch (err) {
      console.error("Twilio message error:", err);
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio websocket closed");

    if (openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.close();
    }
  });

  twilioWs.on("error", (err) => {
    console.error("Twilio websocket error:", err);
  });

  openAiWs.on("close", () => {
    console.log("OpenAI websocket closed");
  });

  openAiWs.on("error", (err) => {
    console.error("OpenAI websocket error:", err);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
