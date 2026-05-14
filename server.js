require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");
////////

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
/** Twilio recording webhooks often omit `To`/`Called`; map parent CallSid → dialed E.164. */
const callSidToLeadPhone = new Map();

function buildGhlContactsUpsertUrl(identifier) {
  const trimmed = String(identifier || "").trim();
  if (!trimmed) return null;
  const u = new URL("https://services.leadconnectorhq.com/contacts/upsert");
  if (trimmed.includes("@")) {
    u.searchParams.set("email", trimmed);
  } else {
    u.searchParams.set("number", trimmed);
  }
  return u.toString();
}

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY in .env");
}

const wss = new WebSocket.Server({
  server,
  path: "/media-stream",
});

/** Lightweight call lifecycle (single source of truth for mode gating). */
const CALL_STATE = Object.freeze({
  IDLE: "IDLE",
  OPENING: "OPENING",
  LISTENING: "LISTENING",
  RESPONDING: "RESPONDING",
  INTERRUPTING: "INTERRUPTING",
  VOICEMAIL: "VOICEMAIL",
  WRONG_NUMBER: "WRONG_NUMBER",
  ENDING: "ENDING",
  ENDED: "ENDED",
});

const US_STATE_BY_ABBREV = Object.freeze({
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "Washington D.C.",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
});

function normalizeAddressForSpeech(address) {
if (!address) return "";

return address
.replace(/\bN\b/gi, "North")
.replace(/\bS\b/gi, "South")
.replace(/\bE\b/gi, "East")
.replace(/\bW\b/gi, "West")
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


function formatSellerFirstName(firstRaw) {
  const t = String(firstRaw || "").trim();
  if (!t) return "there";
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function expandUsStateForSpeech(stateRaw) {
  const raw = String(stateRaw || "").trim();
  if (!raw) return "";
  const compact = raw.replace(/\./g, "").toUpperCase();
  if (compact.length === 2 && US_STATE_BY_ABBREV[compact]) {
    return US_STATE_BY_ABBREV[compact];
  }
  return raw
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Street line only: no leading house numbers, no ZIP, first comma segment. */
function extractStreetLineForSpeech(addressRaw) {
  let line = String(addressRaw || "").trim();
  if (!line) line = "your property";
  line = line.split(",")[0].trim();
  line = line.replace(/^\d+[-A-Za-z]?\s+/, "").trim();
  line = line.replace(/\s+\d{5}(-\d{4})?$/i, "").trim();
  line = normalizeAddressForSpeech(line).trim();
  return line || "your property";
}

function buildSpokenLocationClause(streetName, cityRaw, stateRaw) {
  const street = String(streetName || "").trim() || "your property";
  const city = String(cityRaw || "").trim();
  const stateSpoken = expandUsStateForSpeech(stateRaw);

  if (city && stateSpoken) return `${street} in ${city}, ${stateSpoken}`;
  if (city) return `${street} in ${city}`;
  if (stateSpoken) return `${street} in ${stateSpoken}`;
  return street;
}

/** Precomputed strings for the opener + session (Realtime-safe, no SSML). */
function buildOpenerSpeechContext(lead) {
  const rawAddress =
    lead.address || lead["Property Address"] || lead.streetAddress || "";

  const sellerName = formatSellerFirstName(lead.first_name);
  const streetName = extractStreetLineForSpeech(rawAddress);
  const city = String(lead.city || "").trim();
  const fullStateName = expandUsStateForSpeech(lead.state);
  const locationClause = buildSpokenLocationClause(streetName, city, lead.state);

  const sessionRules = [
    `Opener location (use this exact spoken form for the opening question, and keep house numbers and ZIP codes out of speech): "${locationClause}".`,
    `Always pronounce the U.S. state as full words in this call${
      fullStateName ? ` (say "${fullStateName}")` : ""
    }. Never read a state as separate letters (never "F L", "O H", or "T X").`,
  ].join(" ");

  return {
    sellerName,
    streetName,
    city,
    fullStateName,
    locationClause,
    sessionRules,
  };
}

/** Mandatory first lines (session + response.create). Server fills name/location only. */
function buildFixedOutboundOpenerScript(ctx) {
  const hi = `Hi ${ctx.sellerName}?`;
  const ask = `This is Daniel - Would you potentially be open to selling your property on ${ctx.locationClause}?`;
  return { hi, ask };
}

function buildOutboundOpenerInstructionBlock(ctx) {
  const { hi, ask } = buildFixedOutboundOpenerScript(ctx);
  return [
    "OPENING SCRIPT — first audio after connect (non-negotiable)",
    "",
    "Deliver exactly two spoken parts in order, with natural tone but verbatim wording:",
    `1) Say exactly: ${hi}`,
    `2) Say exactly: ${ask}`,
    "",
    "Do not add any words before step 1. Do not add small talk between steps 1 and 3.",
    "Do not change the location phrase; it must match the session wording character-for-character (aside from normal capitalization in speech).",
    "",
    ctx.sessionRules,
    "",
    "After the prospect answers this opening, treat the rest of the call as a normal conversation (the fixed-script rule no longer applies).",
  ].join("\n");
}

function buildOpenerResponseCreateInstructions(ctx) {
const { hi, ask } = buildFixedOutboundOpenerScript(ctx);

return [
"IMPORTANT — STRICT DELIVERY MODE",
"",
"For the FIRST spoken response ONLY:",
"",
"You MUST say the OPENING SCRIPT exactly as written.",
"",
"",
"Treat the opener like a strict verbal readout.",
"",
"OPENING SCRIPT:",
"",
`1) Say exactly: ${hi}`,
"",
"",
`2) Then say exactly: ${ask}`,
"",
"",
"Once the seller responds:",
"STRICT DELIVERY MODE ENDS.",
"Return to normal conversational behavior.",
].join("\n");
}


const SYSTEM_PROMPT = `
# 1. RULES

You are Daniel, a real estate investor calling property owners.

Speak like a real operator — calm, direct, controlled, and natural.

Use short sentences.
Let the seller speak.

---

LANGUAGE RULE

Speak ONLY in English. UNLESS ASKED / and OTHER LANGUAGE IDENTIFIED /

---

TONE + DELIVERY

* Match the seller’s energy
* Slow down if seller shares something meaningful
* Never stack questions
* Keep the conversation natural and conversational
* Listen carefully before responding
* Do not paraphrase every seller response
* Keep acknowledgements brief and natural

---

CONVERSATION CONTROL

If seller goes off topic:

* briefly acknowledge it
* then naturally redirect back to the property

---

CRITICAL RULES

* NEVER say “in regards to”
* NEVER say “confirm” or “verify”
* NEVER sound like a script
* NEVER argue with the seller
* NEVER push hard on price early
* NEVER sound overly excited
* NEVER sound robotic
* NEVER interrogate the seller

---

YOUR ROLE

You are:

* calm under control
* slightly curious
* easy to talk to
* leading without force

You are NOT:

* aggressive
* robotic
* overly friendly
* overly analytical

==================================================

# 2. SCRIPT / CALL FLOW

==================================================

IF SELLER PUSHES BACK / SAYS NO

Goal:

* soften resistance
* keep conversation alive
* uncover flexibility

Example:

“Sounds like you’re probably not looking right now.”

“If someone came in with the right number though…
you’d at least take a look, right?”

“Right — so there is a number that would make sense.”

“That’s all I’m trying to figure out.”

“Give me like 30 seconds — let me just understand the property real quick.”

---

PROPERTY INFO

Goal:

* determine occupancy and basic situation

Examples:

“Are you living there now or is it rented out?”

If vacant:

* subtly mention holding costs
* then continue naturally

---

CONDITION

Goal:

* understand overall condition
* determine level of updating/work needed

Examples:

“How’s the condition overall?”

“How updated is it?”

“Does it need much work?”

---

MOTIVATION

Goal:

* understand why they would sell
* uncover situation behind the sale

Examples:

“What would ideally happen with the property?”

“What’s the situation with it right now?”

---

TIMELINE

Goal:

* understand urgency and flexibility

Examples:

“If everything made sense - how soon would you want to move on it?”

If unclear:

“Are you thinking more like 30 days… or more a couple months?”

---

PRICE

Goal:

* uncover expectation without pressure

Examples:

“Do you have a number in mind - where you’d seriously consider selling?”

Backup:

“Just trying to understand where you’re at.”

---

POSITIONING

Goal:

* keep interaction low-pressure and straightforward

Examples:

“I honestly dont like to beat around the bush”

“I’m really just trying to understand whether something makes sense for both sides.”

---

SOFT CLOSE

Goal:

* exit naturally
* preserve follow-up opportunity

Examples:

“What I can do is take a look at everything and see what actually makes sense.”

“If it lines up, I’ll give you a call back and we can go from there.”

---

EXIT

Examples:

“I’ll take a look and get back to you.”

“Appreciate you taking the time.”

`;

const MACHINE_PHRASES = [

  "leave a message",
  "your call has been forwarded",
  "voice mailbox",
  "mailbox is full",
  "at the tone",
  "record your message",
  "google voice subscriber",
  "not available",

  "press 1",
  "press one",
  "press 2",
  "for english",
  "main menu",
  "choose an option",
  "please select",
  "invalid selection",
  "using your keypad",
  "say or press",
  "operator",
  "extension",

  "please continue",
  "please repeat",
  "i didn't get that",
  "cannot process",
];

function detectMachineTranscript(text = "") {

  const lower = text.toLowerCase();

  return MACHINE_PHRASES.some(phrase =>
    lower.includes(phrase)
  );
}


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
    const upsertUrl = buildGhlContactsUpsertUrl(phoneOverride);
    if (!upsertUrl) {
      console.warn("GHL UPDATE SKIPPED: missing phone/email identifier for upsert");
      return;
    }

    const response = await fetch(upsertUrl, {
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

app.post("/amd-status", (req, res) => {

  console.log("AMD STATUS:", req.body);

  res.sendStatus(200);
});

app.post("/recording", async (req, res) => {
  const callSid = req.body.CallSid;

  try {
    const recordingUrl = req.body.RecordingUrl + ".mp3";

    const phone =
      (callSid && callSidToLeadPhone.get(callSid)) ||
      req.body.To ||
      req.body.Called ||
      req.body.Caller ||
      req.body.From ||
      currentCallLead.phone;

    console.log("Recording ready:", recordingUrl);
    console.log("Call SID:", callSid);
    console.log("PHONE:", phone);

    const upsertUrl = buildGhlContactsUpsertUrl(phone);
    if (!upsertUrl) {
      console.warn(
        "GHL RECORDING UPDATE SKIPPED: no phone/email (recording callbacks often omit To/Called; ensure CallSid was registered at dial)"
      );
      return res.sendStatus(200);
    }

    const response = await fetch(upsertUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        locationId: process.env.GHL_LOCATION_ID,
        phone: phone,

        customFields: [
          {
            key: "twilio_call_sid",
            field_value: callSid,
          },
          {
            key: "twilio_recording_url",
            field_value: recordingUrl,
          },
        ],
      }),
    });

    const data = await response.json();

    console.log("GHL RECORDING UPDATE:", JSON.stringify(data, null, 2));

    res.sendStatus(200);
  } catch (err) {
    console.error("RECORDING ERROR:", err);
    res.sendStatus(500);
  } finally {
    if (callSid) callSidToLeadPhone.delete(callSid);
  }
});

app.post("/start-call", async (req, res) => {
  try {

    console.log( "RAW GHL BODY:", JSON.stringify(req.body, null, 2) );
    
    const {
      first_name,
      last_name,
      phone,
      full_name,
      name,
      contact_id,
      contactId,
      id,
      property_address,
      streetAddress,
      address,
      city,
      state,
      postal_code,
      zip,
      bed,
      bath,
      sq_ft,
      sqft,
      estimated_value,
      estimatedValue,
      year_built,
      yearBuilt,
      sale_price,
      last_sold,
      lastSold,
      call_notes,
      callNotes,
    } = req.body;

    const cleanPhone = String(phone || "").trim();
    const ghlContactId = String(
      contact_id || contactId || id || req.body.contact?.id || ""
    ).trim();

    const fullNameRaw = String(full_name || name || "").trim();
    const nameParts = fullNameRaw.split(/\s+/).filter(Boolean);
    const resolvedFirst =
      String(first_name || "").trim() ||
      nameParts[0] ||
      "there";
    const resolvedLast =
      String(last_name || "").trim() ||
      (nameParts.length > 1 ? nameParts.slice(1).join(" ") : "");

    currentCallLead = {
      ghl_contact_id: ghlContactId,
      first_name: resolvedFirst,
      last_name: resolvedLast,
      phone: cleanPhone,
      address:
        property_address ||
        req.body["Property Address"] ||
        address ||
        streetAddress ||
        "your property",
      city: String(city || "").trim(),
      state: String(state || "").trim(),
      postal_code: String(postal_code || zip || "").trim(),
      bed: String(bed || "").trim(),
      bath: String(bath || "").trim(),
      sq_ft: String(sq_ft || sqft || "").trim(),
      estimated_value: String(estimated_value || estimatedValue || "").trim(),
      year_built: String(year_built || yearBuilt || "").trim(),
      sale_price: String(sale_price || "").trim(),
      last_sold: String(last_sold || lastSold || "").trim(),
      call_notes: String(call_notes || callNotes || "").trim(),
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
      
      machineDetection: "DetectMessageEnd",
asyncAmd: true,
asyncAmdStatusCallback: `${publicBaseUrl}/amd-status`,
      
  statusCallback: `${publicBaseUrl}/call-status`,
  statusCallbackEvent: ["completed", "no-answer", "busy",  "failed"],
  record: true,
  recordingChannels: "dual",
  recordingStatusCallback: `${publicBaseUrl}/recording`,
  recordingStatusCallbackEvent: ["completed"],
});

    callSidToLeadPhone.set(call.sid, cleanPhone);

    console.log("OUTBOUND CALL STARTED:", call.sid);
    console.log(
      "CALL_CORRELATION:",
      JSON.stringify({
        callSid: call.sid,
        phone: cleanPhone,
        ghl_contact_id: currentCallLead.ghl_contact_id || undefined,
      })
    );

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

  const openerSpeech = buildOpenerSpeechContext(currentCallLead);
  console.log("SPOKEN OPENER CONTEXT:", openerSpeech);

  let streamSid = null;
  let callSid = null;
  let latestMediaTimestamp = 0;
  let responseStartTimestamp = null;
  let lastAssistantItem = null;
  let fullCallTranscript = "";
  let callState = CALL_STATE.IDLE;
  /** Post-opener seller lines appended to fullTranscript for classification. */
  let sellerEngagedPostOpener = false;
  /** Any completed seller transcription (legacy sellerSpoke semantics for CRM). */
  let sellerUtteranceDetected = false;
  let hangupTaskScheduled = false;
  /** True from `response.create` for the opener until `response.done` for that response. */
  let openerInProgress = false;
  let sellerAudioEnabled = false;
  let machineScore = 0;
  /** Twilio often sends `start` after OpenAI already streams opener audio — buffer until `streamSid` exists. */
  const pendingTwilioMediaPayloads = [];
  const MAX_PENDING_MEDIA_CHUNKS = 4000;
  let openerResponseSent = false;
  let openerFallbackTimer = null;

  const openAiWs = new WebSocket(
  "wss://api.openai.com/v1/realtime?model=gpt-realtime-2",
  {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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
  if (hangupTaskScheduled || callState === CALL_STATE.ENDED) return;
  hangupTaskScheduled = true;

  if (
    callState !== CALL_STATE.VOICEMAIL &&
    callState !== CALL_STATE.WRONG_NUMBER
  ) {
    callState = CALL_STATE.ENDING;
  }

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
  const openerBlock = buildOutboundOpenerInstructionBlock(openerSpeech);

  const leadContext = `
CURRENT LEAD CONTEXT:

You are calling:
Name: ${currentCallLead.first_name || ""} ${currentCallLead.last_name || ""}
Property Address: ${currentCallLead.address || ""}
City: ${currentCallLead.city || ""}
State: ${currentCallLead.state || ""}
Zip Code: ${currentCallLead.postal_code || ""}
Estimated Value: ${currentCallLead.estimated_value || ""}
Sq Ft: ${currentCallLead.sq_ft || ""}
Bed: ${currentCallLead.bed || ""}
Bath: ${currentCallLead.bath || ""}
Year Built: ${currentCallLead.year_built || ""}
Sale Price: ${currentCallLead.sale_price || ""}
Last Sold: ${currentCallLead.last_sold || ""}
Call Notes: ${currentCallLead.call_notes || ""}

Use this as background context.
Do NOT read all details out loud.
Mention the property address naturally.
`;

  console.log("CALL LEAD LOADED FROM GHL:", currentCallLead);

 const sessionUpdate = {
  type: "session.update",
  session: {
  type: "realtime",
  output_modalities: ["audio"],

  instructions:
    openerBlock +
    `

` +
    SYSTEM_PROMPT +
    `
` +
    leadContext,

  audio: {
    input: {
      format: {
        type: "audio/pcmu"
      },

      turn_detection: {
        type: "server_vad",
        threshold: 0.76,
        prefix_padding_ms: 850,
        silence_duration_ms: 650,
        /** We drive the opener with an explicit `response.create`; VAD-only auto replies can starve the opener. */
        create_response: false,
        interrupt_response: true,
      }
    },

    output: {
      format: {
        type: "audio/pcmu"
      },

      voice: "cedar"
    }
  }
  }
};
   
console.log(
  "SESSION UPDATE SENT:",
  JSON.stringify(sessionUpdate, null, 2)
);

   
  openAiWs.send(JSON.stringify(sessionUpdate));
}

  function clearTwilioAudio() {
    pendingTwilioMediaPayloads.length = 0;

    if (!streamSid) return;

    twilioWs.send(
      JSON.stringify({
        event: "clear",
        streamSid,
      })
    );
  }

  function flushPendingAssistantAudioToTwilio() {
    if (!streamSid || pendingTwilioMediaPayloads.length === 0) return;

    console.log(
      `TWILIO FLUSH: replaying ${pendingTwilioMediaPayloads.length} buffered assistant audio frame(s)`
    );

    while (pendingTwilioMediaPayloads.length) {
      const payload = pendingTwilioMediaPayloads.shift();
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload },
        })
      );
    }
  }

  function forwardAssistantAudioToTwilio(delta) {
    if (!delta) return;

    if (streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: delta },
        })
      );
      return;
    }

    if (pendingTwilioMediaPayloads.length === 0) {
      console.log(
        "TWILIO BUFFER: assistant audio arrived before stream start — buffering until streamSid"
      );
    }

    if (pendingTwilioMediaPayloads.length >= MAX_PENDING_MEDIA_CHUNKS) {
      console.error("TWILIO BUFFER: cap exceeded; dropping assistant audio chunk");
      return;
    }

    pendingTwilioMediaPayloads.push(delta);
  }

  function sendOpenerResponseOnce(source) {
    if (openerResponseSent) return;
    if (openAiWs.readyState !== WebSocket.OPEN) return;

    openerResponseSent = true;

    if (openerFallbackTimer) {
      clearTimeout(openerFallbackTimer);
      openerFallbackTimer = null;
    }

    console.log("OPENER response.create →", source);

    openerInProgress = true;

    openAiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions: buildOpenerResponseCreateInstructions(openerSpeech),
        },
      })
    );
  }

 function interruptAssistant() {

  if (!lastAssistantItem || responseStartTimestamp === null) return;

  callState = CALL_STATE.INTERRUPTING;

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

  callState = CALL_STATE.OPENING;

  
  await sendSessionUpdate();

  setTimeout(() => {
    sendOpenerResponseOnce("post_session_update_tick");
  }, 200);

  openerFallbackTimer = setTimeout(() => {
    openerFallbackTimer = null;
    sendOpenerResponseOnce("fallback_opener");
  }, 1600);
  });

let fullTranscript = ""; 

openAiWs.on("message", (data) => {
  try {
    const event = JSON.parse(data.toString());
    console.log("OPENAI EVENT:", event.type);

    if (event.type === "response.output_audio.delta") {

  console.log("AUDIO DELTA RECEIVED");

  if (event.item_id) {
    lastAssistantItem = event.item_id;
  }

  if (
    callState === CALL_STATE.LISTENING ||
    callState === CALL_STATE.INTERRUPTING
  ) {
    callState = CALL_STATE.RESPONDING;
  }

  if (!responseStartTimestamp) {
    responseStartTimestamp = latestMediaTimestamp;
  }

  forwardAssistantAudioToTwilio(event.delta);
}

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

  sellerUtteranceDetected = true;

  const transcript = (event.transcript || "").trim();
  const lowerTranscript = transcript.toLowerCase();

  if (detectMachineTranscript(lowerTranscript)) {

    machineScore += 3;

    console.log("MACHINE PHRASE DETECTED");
  }

  if (transcript.length > 200) {

    machineScore += 1;
  }

  console.log("MACHINE SCORE:", machineScore);

  if (machineScore >= 4) {

    console.log("VOICEMAIL / IVR DETECTED");

    callState = CALL_STATE.VOICEMAIL;

    openerInProgress = false;

    fullTranscript += `\nVOICEMAIL: ${transcript}`;
    fullCallTranscript += `VOICEMAIL: ${transcript}\n`;

    interruptAssistant();

    openAiWs.send(JSON.stringify({
      type: "response.cancel"
    }));

    clearTwilioAudio();

    try {

      twilioClient.calls(callSid).update({
        status: "completed"
      });

      console.log("VOICEMAIL CALL ENDED");

    } catch (err) {

      console.error("FAILED TO END VOICEMAIL CALL:", err);

    }

    return;
  }

  // rest of your existing logic below

console.log("SELLER SAID:", transcript);




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

    callState = CALL_STATE.WRONG_NUMBER;
    openerInProgress = false;

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
  // NORMAL HUMAN SPEECH (only after opener — realtime mode)
  // =========================

  const realtimeConversation =
    callState === CALL_STATE.LISTENING ||
    callState === CALL_STATE.RESPONDING ||
    callState === CALL_STATE.INTERRUPTING;

  if (!realtimeConversation) {
    console.log("SELLER SPEECH DURING OPENER — deferred until LISTENING");
    fullCallTranscript += `SELLER (during opener): ${transcript}\n`;
    return;
  }

  sellerEngagedPostOpener = true;

 fullTranscript += `\nSeller: ${transcript}`;
fullCallTranscript += `SELLER: ${transcript}\n`;

  }


    // user starts speaking → stop any current playback (realtime mode only)
if (event.type === "input_audio_buffer.speech_started") {
  console.log("Possible user speech detected");

  const canInterrupt =
    callState === CALL_STATE.LISTENING ||
    callState === CALL_STATE.RESPONDING;

  if (!canInterrupt) {
    console.log("Ignoring speech_started during opener/startup");
    return;
  }

  interruptAssistant();

  setTimeout(() => {
    clearTwilioAudio();
    if (callState === CALL_STATE.INTERRUPTING) {
      callState = CALL_STATE.LISTENING;
    }
  }, 450);
}

    if (event.type === "input_audio_buffer.speech_stopped") {
      if (
        callState === CALL_STATE.VOICEMAIL ||
        callState === CALL_STATE.WRONG_NUMBER ||
        callState === CALL_STATE.ENDING ||
        callState === CALL_STATE.ENDED
      ) {
        return;
      }

      if (callState === CALL_STATE.OPENING) {
        return;
      }

      if (
        callState === CALL_STATE.RESPONDING ||
        callState === CALL_STATE.INTERRUPTING
      ) {
        return;
      }

      if (openAiWs.readyState !== WebSocket.OPEN) return;

      console.log("SPEECH STOPPED → response.create (manual reply turn)");

      openAiWs.send(
        JSON.stringify({
          type: "response.create",
        })
      );
    }


    // safety: end-call checks
    if (event.type === "response.done") {
      if (openerInProgress) {
        openerInProgress = false;

        if (callState === CALL_STATE.OPENING) {
          callState = CALL_STATE.LISTENING;
          console.log("OPENER ACTUALLY FINISHED → LISTENING");
        }
      }

      const text = JSON.stringify(event);

      if (shouldEndCall(text)) {
        scheduleEndCall(text);
      }

      if (
        callState === CALL_STATE.RESPONDING ||
        callState === CALL_STATE.INTERRUPTING
      ) {
        callState = CALL_STATE.LISTENING;
      }

      responseStartTimestamp = null;
      lastAssistantItem = null;
    }

    if (event.type === "error") {
      console.error("OpenAI realtime error:", event.error || event);
    }
  } catch (err) {
    console.error("OpenAI message parse error:", err);
  }
});

 twilioWs.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === "start") {
          machineScore = 0;

        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;

        sellerAudioEnabled = false;

setTimeout(() => {

  sellerAudioEnabled = true;

  console.log("SELLER AUDIO ENABLED");

}, 8250);

        console.log("Twilio stream started:", {
          streamSid,
          callSid,
        });

        flushPendingAssistantAudioToTwilio();

        return;
      }

   if (msg.event === "media") {

  latestMediaTimestamp = msg.media.timestamp;

  // Ignore seller audio during opener
  if (!sellerAudioEnabled) {
    return;
  }

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

  openerInProgress = false;

  if (openerFallbackTimer) {
    clearTimeout(openerFallbackTimer);
    openerFallbackTimer = null;
  }

  const wrongNumberAlreadyHandled =
    callState === CALL_STATE.WRONG_NUMBER;

  callState = CALL_STATE.ENDED;



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

if (wrongNumberAlreadyHandled) {
  console.log("Skipping final classification because wrong number was already detected.");
} else if (!sellerUtteranceDetected) {
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

    if (openerFallbackTimer) {
      clearTimeout(openerFallbackTimer);
      openerFallbackTimer = null;
    }

    openerInProgress = false;

    if (openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.close();
    }
  });

  twilioWs.on("error", (err) => {
    console.error("Twilio websocket error:", err);
  });

  openAiWs.on("close", () => {
    console.log("OpenAI websocket closed");

    if (openerFallbackTimer) {
      clearTimeout(openerFallbackTimer);
      openerFallbackTimer = null;
    }

    openerInProgress = false;
  });

  openAiWs.on("error", (err) => {
    console.error("OpenAI websocket error:", err);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
