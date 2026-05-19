require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");
///
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
/** Elapsed-ms prefix for call-scoped logs (reset on each /start-call). */
let callStartTime = null;

function logTime(...args) {
  const elapsed = callStartTime != null ? Date.now() - callStartTime : 0;
  console.log(`[${elapsed}ms]`, ...args);
}

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
  const hi = `Hi ${ctx.sellerName}...?`;
  const ask = `This is Daniel - Would you sell your property on ${ctx.locationClause}?`;
  return { hi, ask };
}

/** Full opener line for instant TTS (no Realtime generation wait). */
function buildOpenerSpokenLine(ctx) {
  const { hi, ask } = buildFixedOutboundOpenerScript(ctx);
  return `${hi} ${ask}`;
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

/** ElevenLabs stream-input: expressiveness presets (not semantic labels). */
const ELEVEN_TONE_PRESETS = Object.freeze({
  neutral: {
    stability: 0.42,
    similarity_boost: 0.9,
    style: 0.28,
    use_speaker_boost: true,
  },

  confidence: {
    stability: 0.34,
    similarity_boost: 0.92,
    style: 0.58,
    use_speaker_boost: true,
  },

  understanding: {
    stability: 0.3,
    similarity_boost: 0.9,
    style: 0.52,
    use_speaker_boost: true,
  },

  emphasis: {
    stability: 0.22,
    similarity_boost: 0.94,
    style: 0.82,
    use_speaker_boost: true,
  },
});

const SELLER_PUSHBACK_PHRASES = [
  "not interested",
  "don't call",
  "do not call",
  "stop calling",
  "no thanks",
  "not selling",
  "take me off",
  "leave me alone",
  "already told you",
];

const EMPATHY_SELLER_PHRASES = [
  "passed away",
  "divorce",
  "hard time",
  "struggling",
  "foreclosure",
  "probate",
  "sick",
  "hospital",
];

const EMPHASIS_TOPIC_WORDS = [
  "price",
  "number",
  "timeline",
  "month",
  "months",
  "days",
  "offer",
  "worth",
  "dollar",
  "cash",
];

/** Default voice for the whole call — set once on Eleven WS init only. */
const ELEVEN_SESSION_VOICE_SETTINGS = ELEVEN_TONE_PRESETS.neutral;

function shapeTextForEleven(text, tone = "neutral") {
  let t = String(text || "");
  t = t.replace(/\[\[(?:tone|mode):\s*[\w-]+\]\]/gi, "");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/\s+/g, " ").trim();

  if (tone === "understanding" && t && !/[.!?…]/.test(t.slice(-1))) {
    t += ".";
  }

  return t;
}

function normalizeApostrophes(text) {
  return String(text || "")
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"');
}

/**
 * Mid-response TTS flush: stream statements early, but never split on "?".
 * Multiple Eleven flushes on "?" caused back-to-back questions in one turn.
 */
function shouldFlushElevenBuffer(buffer, { forceFinal = false } = {}) {
  const text = String(buffer || "");
  if (!text.trim()) return false;
  if (forceFinal) return true;
  if (text.length >= 220) return true;
  return /[.!](?:\s|$)/.test(text);
}

function inferElevenTone(callState, lastSellerLine, assistantText) {
  const seller = String(lastSellerLine || "").toLowerCase();
  const assistant = String(assistantText || "").toLowerCase();

  if (callState === CALL_STATE.OPENING) return "confidence";

  if (
    SELLER_PUSHBACK_PHRASES.some((p) => seller.includes(p)) ||
    EMPATHY_SELLER_PHRASES.some((p) => seller.includes(p))
  ) {
    return "understanding";
  }

  if (EMPHASIS_TOPIC_WORDS.some((p) => seller.includes(p) || assistant.includes(p))) {
    return "emphasis";
  }

  return "neutral";
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
* Never stack questions — at most ONE question per reply, and only ONE "?" in spoken output
* When closing or saying goodbye, do NOT ask a new discovery question in the same reply
* Keep the conversation natural and conversational
* Listen carefully before responding
* Do not paraphrase every seller response
* Keep acknowledgements brief and natural

DELIVERY MODES (pick one per reply; never name the mode out loud)

CONFIDENCE — calm, steady, declarative. Short clauses. Example shape: "Got it." / "That makes sense." / "Here's what I'd do."

UNDERSTANDING — validate first, one beat, then one question. Example: "Yeah, I hear you." then "What's driving that?"

EMPHASIS — stress ONE idea only (price, timeline, or location). Put the key word at the end of a short phrase.

Write how you would SAY it (punctuation and short lines). Do not use tags, brackets, or markdown in spoken output.

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

Pick ONE line (do not chain both):

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

If unclear, pick ONE (never both in the same reply):

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
* one short line only — no new timeline or price questions in the same reply as goodbye

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

function isTwilioAmdMachineOrFax(answeredByRaw) {
  const answeredBy = String(answeredByRaw || "").toLowerCase();
  return (
    answeredBy.includes("machine") || answeredBy.includes("fax")
  );
}

function resolveOutboundLeadPhone(req) {
  const callSid = req.body.CallSid || req.query.CallSid;
  return (
    (callSid && callSidToLeadPhone.get(callSid)) ||
    req.body.To ||
    req.body.Called ||
    req.query.To ||
    ""
  );
}

async function updateGHL(outcome, summary, phoneOverride) {
  try {
    const upsertUrl = buildGhlContactsUpsertUrl(phoneOverride);
    if (!upsertUrl) {
      console.warn("GHL UPDATE SKIPPED: missing phone/email identifier for upsert");
      return;
    }
    
const TAG_BY_OUTCOME = {
  no_answer_voicemail: "ai_no_answer",
  follow_up: "ai_follow_up",
  interested: "ai_interested",
  not_interested: "ai_not_interested",
  wrong_number: "ai_wrong_number",
};

const outcomeTag = TAG_BY_OUTCOME[outcome];
    
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
  tags: outcomeTag ? [outcomeTag] : [],
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
    logTime("GHL UPDATED:", data);
  } catch (err) {
    console.error("GHL UPDATE ERROR:", err);
  }
}

/** Dedupe GHL "no answer" from AMD: both `/voice` and `completed` status may fire. */
const twilioAmdNoAnswerGhlSyncedCallSids = new Set();

async function syncTwilioAmdNoAnswerToGhl(callSid, answeredByRaw, phone, detailSuffix) {
  if (callSid && twilioAmdNoAnswerGhlSyncedCallSids.has(callSid)) {
    return;
  }
  if (callSid) {
    twilioAmdNoAnswerGhlSyncedCallSids.add(callSid);
  }

  const base = `Twilio AMD blocked the call (answered_by=${answeredByRaw || "machine"}); no AI session.`;
  const detail = detailSuffix ? `${base} ${detailSuffix}` : base;

  await updateGHL("no_answer_voicemail", detail, phone);
}

app.all("/voice", (req, res) => {
  const answeredByRaw = req.body.AnsweredBy || req.query.AnsweredBy || "";
  const answeredBy = String(answeredByRaw).toLowerCase();

  logTime("VOICE ANSWERED BY:", answeredBy);

  if (isTwilioAmdMachineOrFax(answeredByRaw)) {
    logTime("VOICEMAIL DETECTED BEFORE AI");

    const phone = resolveOutboundLeadPhone(req);

    void syncTwilioAmdNoAnswerToGhl(
      req.body.CallSid || req.query.CallSid,
      answeredByRaw,
      phone
    ).catch((err) => {
      console.error("GHL UPDATE (AMD hangup /voice):", err);
    });

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;

    return res.type("text/xml").send(twiml);
  }

  const publicBaseUrl = getPublicBaseUrl(req);
  const wsUrl =
    publicBaseUrl.replace(/^http/i, "ws") + "/media-stream";

  logTime("VOICE HIT:", wsUrl);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

app.post("/call-status", async (req, res) => {
  try {
    logTime("CALL STATUS:", req.body);

    const callStatus = req.body.CallStatus;
    const callDuration = Number(req.body.Duration || req.body.CallDuration || 0);
    const phone =
      (req.body.CallSid && callSidToLeadPhone.get(req.body.CallSid)) ||
      req.body.To ||
      req.body.Called;

    const answeredByRaw = req.body.AnsweredBy || "";
    const amdVoicemail = isTwilioAmdMachineOrFax(answeredByRaw);

    logTime("PHONE FROM TWILIO:", phone);
    logTime("CALL DURATION USED:", callDuration);
    logTime("CALL STATUS ANSWERED BY:", answeredByRaw);

    if (
      callStatus === "no-answer" ||
      callStatus === "busy" ||
      callStatus === "failed"
    ) {
      logTime("TRIGGERING GHL UPDATE FOR NO ANSWER");

      await updateGHL(
        "no_answer_voicemail",
        `Call ended with status: ${callStatus} and duration ${callDuration} seconds.`,
        phone
      );
    } else if (amdVoicemail && callStatus === "completed") {
      logTime("TRIGGERING GHL UPDATE FOR AMD VOICEMAIL (COMPLETED)");

      await syncTwilioAmdNoAnswerToGhl(
        req.body.CallSid,
        answeredByRaw,
        phone,
        `Call completed; duration ${callDuration}s.`
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("CALL STATUS ERROR:", err);
    res.sendStatus(500);
  }
});

app.post("/amd-status", async (req, res) => {
  try {
    const answeredByRaw = req.body.AnsweredBy || "";
    const callSid = req.body.CallSid;

    logTime("AMD STATUS:", req.body);

    if (callSid && isTwilioAmdMachineOrFax(answeredByRaw)) {
      logTime("ASYNC AMD VOICEMAIL — ending call:", callSid);

      const phone = resolveOutboundLeadPhone(req);

      await syncTwilioAmdNoAnswerToGhl(
        callSid,
        answeredByRaw,
        phone,
        "Async AMD detected machine after connect."
      ).catch((err) => {
        console.error("GHL UPDATE (async AMD):", err);
      });

      await twilioClient.calls(callSid).update({ status: "completed" });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("AMD STATUS ERROR:", err);
    res.sendStatus(500);
  }
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

    logTime("Recording ready:", recordingUrl);
    logTime("Call SID:", callSid);
    logTime("PHONE:", phone);

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

    logTime("GHL RECORDING UPDATE:", JSON.stringify(data, null, 2));

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
    callStartTime = Date.now();

    logTime("RAW GHL BODY:", JSON.stringify(req.body, null, 2));
    
    const body = req.body || {};

const first_name = body.first_name || body.firstName || "";
const last_name = body.last_name || body.lastName || "";
const full_name = body.full_name || body.fullName || body.name || "";
const phone = body.phone || "";

const property_address =
  body.property_address ||
  body.propertyAddress ||
  body["Property Address"] ||
  body.address ||
  body.streetAddress ||
  "";

const city = body.city || "";
const state = body.state || "";
const postal_code = body.postal_code || body.postalCode || body.zip || "";

const bed = body.bed || body.beds || body["Bed"] || "";
const bath = body.bath || body.baths || body["Bath"] || "";
const sq_ft = body.sq_ft || body.sqFt || body["Sq Ft"] || "";

const estimated_value =
  body.estimated_value ||
  body.estimatedValue ||
  body["Estimated Value"] ||
  "";

const year_built =
  body.year_built ||
  body.yearBuilt ||
  body["Year Built"] ||
  "";

const sale_price =
  body.sale_price ||
  body.salePrice ||
  body["Sale Price"] ||
  "";

const last_sold =
  body.last_sold ||
  body.lastSold ||
  body["Last Sold"] ||
  "";

const call_notes =
  body.call_notes ||
  body.callNotes ||
  "";

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

    logTime("GHL WEBHOOK HIT:", currentCallLead);

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
      // Sync AMD blocks TwiML (and Media Stream) for ~4–10s after answer — use async.
      machineDetection: "Enable",
      asyncAmd: true,
      asyncAmdStatusCallback: `${publicBaseUrl}/amd-status`,
      asyncAmdStatusCallbackMethod: "POST",
  statusCallback: `${publicBaseUrl}/call-status`,
  statusCallbackEvent: ["completed", "no-answer", "busy",  "failed"],
  record: true,
  recordingChannels: "dual",
  recordingStatusCallback: `${publicBaseUrl}/recording`,
  recordingStatusCallbackEvent: ["completed"],
});

    callSidToLeadPhone.set(call.sid, cleanPhone);

    logTime("OUTBOUND CALL STARTED:", call.sid);

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
  if (callStartTime == null) {
    callStartTime = Date.now();
  }

  logTime("Twilio websocket connected");

  const openerSpeech = buildOpenerSpeechContext(currentCallLead);
  logTime("SPOKEN OPENER CONTEXT:", openerSpeech);

let firstDeltaReceived = false;
let firstTextToEleven = false;
let firstElevenAudio = false;
let firstTwilioAudio = false;

  let streamSid = null;
  let callSid = null;
  let latestMediaTimestamp = 0;
  let fullCallTranscript = "";
  let callState = CALL_STATE.IDLE;
  let elevenWs = null;
  let elevenBuffer = "";
  let lastSellerTranscript = "";
  let directOpenerPlayed = false;
  let openerPlaybackEndTimer = null;
  /** Post-opener seller lines appended to fullTranscript for classification. */
  let sellerEngagedPostOpener = false;
  /** Any completed seller transcription (legacy sellerSpoke semantics for CRM). */
  let sellerUtteranceDetected = false;
  let hangupTaskScheduled = false;
  let sellerAudioEnabled = false;
  let machineScore = 0;
  /** Twilio often sends `start` after OpenAI already streams opener audio — buffer until `streamSid` exists. */
  const pendingTwilioMediaPayloads = [];
  const MAX_PENDING_MEDIA_CHUNKS = 4000;
  let responseInProgress = false;
  /** Block new seller turns until estimated assistant audio finishes. */
  let assistantPlaybackUntil = 0;
  let assistantPlaybackTimer = null;

  const openAiWs = new WebSocket(
  "wss://api.openai.com/v1/realtime?model=gpt-realtime-2",
  {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
  }
);

 function shouldEndCall(text) {
  const t = normalizeApostrophes(text).toLowerCase();

  const hardGoodbye =
    t.includes("have a good one") ||
    t.includes("have a good day") ||
    t.includes("talk soon") ||
    t.includes("take care") ||
    t.includes("bye");

  const clearClose =
    t.includes("i'll give you a call back") ||
    t.includes("i'll follow up with you") ||
    t.includes("i'll circle back with you") ||
    t.includes("ill give you a call back") ||
    t.includes("ill follow up with you") ||
    t.includes("ill circle back with you");

  return hardGoodbye || clearClose;
}

async function classifyCall(transcript) {
  try {
    const text = String(transcript || "").toLowerCase();

    if (!transcript || transcript.trim().length < 10) {
      return {
        ai_call_outcome: "follow_up",
        call_summary: "Seller answered but the conversation was too short to classify clearly.",
      };
    }

    const wrongNumberPhrases = [
      "wrong number",
      "you have the wrong number",
      "not my property",
      "i don't own that",
      "i dont own that",
      "who is this for",
    ];

    if (wrongNumberPhrases.some((p) => text.includes(p))) {
      return {
        ai_call_outcome: "wrong_number",
        call_summary: "Person indicated this is the wrong number or they do not own the property.",
      };
    }

    const notInterestedPhrases = [
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

    if (notInterestedPhrases.some((p) => text.includes(p))) {
      return {
        ai_call_outcome: "not_interested",
        call_summary: "Seller clearly rejected the call or said they are not interested.",
      };
    }

    const interestedPhrases = [
      "what would you offer",
      "make me an offer",
      "send me an offer",
      "how much",
      "what's your offer",
      "whats your offer",
      "i would sell",
      "i'd sell",
      "i am interested",
      "i'm interested",
      "possibly selling",
      "open to selling",
      "yes i'm open",
      "yes im open",
    ];

    if (interestedPhrases.some((p) => text.includes(p))) {
      return {
        ai_call_outcome: "interested",
        call_summary: "Seller showed interest in selling or asked about an offer/next steps.",
      };
    }

    const followUpPhrases = [
      "call me back",
      "call back",
      "follow up",
      "later",
      "not right now",
      "maybe",
      "send me more information",
      "i need to think",
      "talk another time",
      "busy",
      "at work",
    ];

    if (followUpPhrases.some((p) => text.includes(p))) {
      return {
        ai_call_outcome: "follow_up",
        call_summary: "Seller answered and requested follow up or seemed unsure.",
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

Return ONLY valid JSON:
{
  "ai_call_outcome": "follow_up | interested | not_interested | wrong_number",
  "call_summary": "short summary"
}

Important:
- Only classify no answer outside this function. If this function is called, a human likely answered.
- wrong_number = person says wrong number, not their property, or they do not own it.
- interested = seller is open to selling, asks about price/offer, gives timeline/condition, or wants next steps.
- not_interested = seller clearly rejects, says not interested, stop calling, remove me, already sold, or not selling.
- follow_up = seller is unsure, busy, says maybe later, asks to call back, needs time, or conversation is unclear.

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
      "follow_up",
      "interested",
      "not_interested",
      "wrong_number",
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

  logTime("AUTO ENDING CALL:", reason);

  setTimeout(async () => {
    try {
      if (callSid) {
        logTime("FORCE END CALL:", callSid);

        await twilioClient.calls(callSid).update({
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
Do NOT read every detail out loud.
Mention the property address naturally if helpful.
`;

  logTime("CALL LEAD LOADED FROM GHL:", currentCallLead);

   logTime("SESSION.UPDATE SENT");
 const sessionUpdate = {
   
  type: "session.update",
  session: {
  type: "realtime",
  output_modalities: ["text"],

  instructions:
    SYSTEM_PROMPT +
    `
` +
    leadContext,

  audio: {
  input: {
    format: {
      type: "audio/pcmu",
    },

    transcription: {
      model: "gpt-4o-mini-transcribe",
    },

    turn_detection: {
      type: "server_vad",
      threshold: 0.85,
      prefix_padding_ms: 700,
      silence_duration_ms: 575,
      create_response: false,
      interrupt_response: true,
    },
  },
},
},
};   
   
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

    logTime(
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

  function extendAssistantPlaybackEstimate(base64Payload) {
    if (!base64Payload) return;

    const bytes = Buffer.from(base64Payload, "base64").length;
    const durationMs = Math.ceil((bytes / 8000) * 1000) + 250;
    assistantPlaybackUntil = Math.max(
      assistantPlaybackUntil,
      Date.now() + durationMs
    );

    if (assistantPlaybackTimer) {
      clearTimeout(assistantPlaybackTimer);
    }

    assistantPlaybackTimer = setTimeout(() => {
      assistantPlaybackTimer = null;
      if (
        callState === CALL_STATE.RESPONDING &&
        Date.now() >= assistantPlaybackUntil
      ) {
        callState = CALL_STATE.LISTENING;
        logTime("ASSISTANT PLAYBACK DONE → LISTENING");
      }
    }, durationMs + 50);
  }

  function forwardAssistantAudioToTwilio(delta) {
    if (!delta) return;

    extendAssistantPlaybackEstimate(delta);

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
      logTime(
        "TWILIO BUFFER: assistant audio arrived before stream start — buffering until streamSid"
      );
    }

    if (pendingTwilioMediaPayloads.length >= MAX_PENDING_MEDIA_CHUNKS) {
      console.error("TWILIO BUFFER: cap exceeded; dropping assistant audio chunk");
      return;
    }

    pendingTwilioMediaPayloads.push(delta);
  }


/** @returns {boolean} whether playback was interrupted */
function interruptAssistant() {

  callState = CALL_STATE.INTERRUPTING;
  elevenBuffer = "";
  assistantPlaybackUntil = 0;

  if (assistantPlaybackTimer) {
    clearTimeout(assistantPlaybackTimer);
    assistantPlaybackTimer = null;
  }

  clearTwilioAudio();


  if (openAiWs.readyState === WebSocket.OPEN) {
    openAiWs.send(JSON.stringify({
      type: "response.cancel"
    }));
  }

  return true;
}

  function sendTextToEleven(ws, rawText, options = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;

    const tone =
      options.tone ||
      inferElevenTone(callState, lastSellerTranscript, rawText);
    const shaped = shapeTextForEleven(rawText, tone);
    if (!shaped) return null;

    // ElevenLabs: voice_settings only on the first WS message — never repeat or change.
    const payload = { text: shaped };

    if (options.flush !== false) {
      payload.flush = true;
    }

    ws.send(JSON.stringify(payload));

    if (
      callState === CALL_STATE.LISTENING ||
      callState === CALL_STATE.INTERRUPTING
    ) {
      callState = CALL_STATE.RESPONDING;
    }

    return { shaped, tone };
  }

  function attachElevenLabsHandlers(ws) {
    ws.on("message", (data) => {
      try {
        const audioChunk = JSON.parse(data.toString());

        if (audioChunk.audio) {
          if (!firstElevenAudio) {
            firstElevenAudio = true;
            logTime("FIRST ELEVEN AUDIO RECEIVED");
          }

          if (!firstTwilioAudio) {
            firstTwilioAudio = true;
            logTime("FIRST AUDIO SENT TO TWILIO");
          }

          if (callState === CALL_STATE.OPENING) {
            scheduleOpenerPlaybackEnd();
          }

          forwardAssistantAudioToTwilio(audioChunk.audio);
        }
      } catch (err) {
        console.error("ELEVEN MESSAGE PARSE ERROR:", err);
      }
    });

    ws.on("error", (err) => {
      console.error("ElevenLabs websocket error:", err);
    });

    ws.on("close", (code, reason) => {
      logTime(
        "ElevenLabs websocket closed",
        "code:",
        code,
        "reason:",
        reason?.toString?.() || ""
      );
    });
  }

  function scheduleOpenerPlaybackEnd() {
    if (openerPlaybackEndTimer) {
      clearTimeout(openerPlaybackEndTimer);
    }

    openerPlaybackEndTimer = setTimeout(() => {
      openerPlaybackEndTimer = null;
      if (callState !== CALL_STATE.OPENING) return;

      callState = CALL_STATE.LISTENING;
      logTime("DIRECT OPENER PLAYBACK DONE → LISTENING");
    }, 1200);
  }

  function seedOpenerInOpenAiConversation(spokenLine) {
    if (openAiWs.readyState !== WebSocket.OPEN) return;

    openAiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: spokenLine }],
        },
      })
    );
  }

  function playDirectOpenerToEleven(source) {
    if (directOpenerPlayed) return;
    if (!elevenWs || elevenWs.readyState !== WebSocket.OPEN) return;

    directOpenerPlayed = true;
    callState = CALL_STATE.OPENING;

    const spokenLine = buildOpenerSpokenLine(openerSpeech);

    logTime(`DIRECT OPENER TTS (${source})`);
    logTime("DIRECT OPENER TO ELEVEN:", spokenLine);

    sendTextToEleven(elevenWs, spokenLine, { flush: true });

    if (!firstTextToEleven) {
      firstTextToEleven = true;
      logTime("FIRST TEXT SENT TO ELEVEN (direct opener)");
    }

    fullCallTranscript += `ASSISTANT (opener): ${spokenLine}\n`;
    seedOpenerInOpenAiConversation(spokenLine);

    setTimeout(() => {
      if (callState === CALL_STATE.OPENING) {
        callState = CALL_STATE.LISTENING;
        logTime("OPENER MAX DURATION FALLBACK → LISTENING");
      }
    }, 15000);
  }

  function connectElevenLabs() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `wss://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/stream-input?output_format=ulaw_8000&model_id=eleven_flash_v2_5`,
        {
          headers: {
            "xi-api-key": process.env.ELEVENLABS_API_KEY,
          },
        }
      );

      ws.on("open", () => {
        logTime("ELEVENLABS WS OPEN");

        ws.send(
          JSON.stringify({
            text: " ",
            voice_settings: ELEVEN_SESSION_VOICE_SETTINGS,
            generation_config: {
              chunk_length_schedule: [50, 120, 160, 250],
            },
          })
        );

        resolve(ws);
      });

      ws.on("error", reject);
    });
  }

openAiWs.on("open", async () => {
  logTime("OPENAI WS OPEN");
  callState = CALL_STATE.OPENING;

  try {
    elevenWs = await connectElevenLabs();
    attachElevenLabsHandlers(elevenWs);
  } catch (err) {
    console.error("ElevenLabs connection failed:", err);
    return;
  }

  await sendSessionUpdate();

  playDirectOpenerToEleven("post_session_update");
});
  
let fullTranscript = ""; 

openAiWs.on("message", async (data) => {
  try {
    const event = JSON.parse(data.toString());
    
if (
  event.type === "response.output_text.delta" ||
  event.type === "response.text.delta"
) {

  if (!firstDeltaReceived) {
    firstDeltaReceived = true;
    logTime("FIRST OPENAI TEXT DELTA");
  }

  const delta = event.delta ?? "";

  if (callState === CALL_STATE.OPENING) {
    return;
  }

  elevenBuffer += delta;

  const shouldFlush = shouldFlushElevenBuffer(elevenBuffer);

  if (
    shouldFlush &&
    elevenWs &&
    elevenWs.readyState === WebSocket.OPEN
  ) {
    
    if (!firstTextToEleven) {
  firstTextToEleven = true;
  logTime("FIRST TEXT SENT TO ELEVEN");
}

    const sent = sendTextToEleven(elevenWs, elevenBuffer, { flush: true });
    if (sent) {
      logTime("SENT TO ELEVEN:", sent.shaped, `(tone: ${sent.tone})`);
    }

    elevenBuffer = "";
  }

}

    if (event.type === "conversation.item.created") {
      const item = event.item;

      if (item?.type === "message" && item.role === "user") {
        const userText = item.content?.[0]?.transcript?.trim();

        if (userText) {
          logTime("USER SAID:", userText);
          fullCallTranscript += `USER: ${userText}\n`;
        }
      }
    }

if (event.type === "conversation.item.input_audio_transcription.completed") {

  sellerUtteranceDetected = true;

  const transcript = (event.transcript || "").trim();
  if (transcript) {
    lastSellerTranscript = transcript;
  }
  const lowerTranscript = transcript.toLowerCase();

  if (detectMachineTranscript(lowerTranscript)) {

    machineScore += 3;

    logTime("MACHINE PHRASE DETECTED");
  }
  
  logTime("MACHINE SCORE:", machineScore);

  if (machineScore >= 3) {

    logTime("VOICEMAIL / IVR DETECTED");

    callState = CALL_STATE.VOICEMAIL;

    fullTranscript += `\nVOICEMAIL: ${transcript}`;
    fullCallTranscript += `VOICEMAIL: ${transcript}\n`;

   interruptAssistant();

    openAiWs.send(JSON.stringify({
      type: "response.cancel"
    }));

    clearTwilioAudio();

    try {

      await twilioClient.calls(callSid).update({
  status: "completed"
});

      logTime("VOICEMAIL CALL ENDED");

    } catch (err) {

      console.error("FAILED TO END VOICEMAIL CALL:", err);

    }

    return;
  }

  // rest of your existing logic below

logTime("SELLER SAID:", transcript);




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
    logTime("WRONG NUMBER DETECTED");

    callState = CALL_STATE.WRONG_NUMBER;
    fullTranscript += `\nWRONG NUMBER: ${transcript}`;
    fullCallTranscript += `WRONG NUMBER: ${transcript}\n`;

    updateGHL(
      "wrong_number",
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
    logTime("SELLER SPEECH DURING OPENER — deferred until LISTENING");
    fullCallTranscript += `SELLER (during opener): ${transcript}\n`;
    return;
  }

  sellerEngagedPostOpener = true;

 fullTranscript += `\nSeller: ${transcript}`;
fullCallTranscript += `SELLER: ${transcript}\n`;

  }


    // user starts speaking → stop any current playback (realtime mode only)
    if (event.type === "input_audio_buffer.speech_started") {
      logTime("Possible user speech detected");

      const canInterrupt =
        callState === CALL_STATE.LISTENING ||
        callState === CALL_STATE.RESPONDING;

      if (!canInterrupt) {
        logTime("Ignoring speech_started during opener/startup");
        return;
      }

      const interrupted = interruptAssistant();

      if (interrupted) {
        setTimeout(() => {
          if (callState === CALL_STATE.INTERRUPTING) {
            callState = CALL_STATE.LISTENING;
          }
        }, 450);
      }
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

if (responseInProgress) {
  return;
}

if (Date.now() < assistantPlaybackUntil) {
  logTime("SPEECH STOPPED ignored — assistant still playing");
  return;
}

responseInProgress = true;

logTime("SPEECH STOPPED → response.create (manual reply turn)");

openAiWs.send(
  JSON.stringify({
    type: "response.create",
  })
);
      }


    // safety: end-call checks
   if (event.type === "response.done") {

  responseInProgress = false;

  if (
    elevenBuffer &&
    elevenWs &&
    elevenWs.readyState === WebSocket.OPEN
  ) {

    const finalSent = sendTextToEleven(elevenWs, elevenBuffer, {
      flush: true,
    });
    if (finalSent) {
      logTime(
        "FINAL ELEVEN FLUSH:",
        finalSent.shaped,
        `(tone: ${finalSent.tone})`
      );
    }

    elevenBuffer = "";
  }

  const assistantText =
    event.response?.output
      ?.flatMap((item) => item.content || [])
      ?.map((part) => part.text || "")
      .join(" ") || JSON.stringify(event);

  if (shouldEndCall(assistantText)) {
    scheduleEndCall(assistantText);
  }

  if (callState === CALL_STATE.INTERRUPTING) {
    callState = CALL_STATE.LISTENING;
  }
}
    
    if (event.type === "error") {
      
        responseInProgress = false;

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
          logTime("SELLER AUDIO ENABLED");
        }, 6500);

        logTime("TWILIO STREAM START (streamSid ready)", {
          streamSid,
          callSid,
        });

        flushPendingAssistantAudioToTwilio();
        playDirectOpenerToEleven("twilio_stream_start");

        return;
      }

   if (msg.event === "media") {

  latestMediaTimestamp = msg.media.timestamp;

  // Ignore seller audio during opener (8.25s from stream start)
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
  logTime("Twilio stream stopped:", {
    streamSid,
    callSid,
  });

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

    logTime("CALL SUMMARY:", summary);
  }

if (wrongNumberAlreadyHandled) {
  logTime("Skipping final classification because wrong number was already detected.");
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
    logTime("Twilio websocket closed");

    if (openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.close();
    }
  });

  twilioWs.on("error", (err) => {
    console.error("Twilio websocket error:", err);
  });

  openAiWs.on("close", () => {
    logTime("OpenAI websocket closed");

  });

  openAiWs.on("error", (err) => {
    console.error("OpenAI websocket error:", err);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
