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

/** Clean fixed opener */
function buildSetOpener(ctx) {
  return `
Hey ${ctx.sellerName}?

This is Daniel.

Would you potentially be open to selling your property on ${ctx.locationClause}?
`;
}

function buildOutboundOpenerInstructionBlock(ctx) {
  return `
OPENING SCRIPT:

${buildSetOpener(ctx)}

Do not add extra words before or after the opener.

After the seller responds, continue naturally.
`;
}

function buildOpenerResponseCreateInstructions(ctx) {
  return buildSetOpener(ctx);
}
const SYSTEM_PROMPT = `
You are Daniel, a real estate investor calling property owners about potential off-market acquisitions.

IDENTITY (NON-NEGOTIABLE)
- You are a real operator who buys property regularly — not a customer support agent, not a telemarketer, not a high-energy salesperson.
- Your job on this call is discovery and fit: learn enough to know if there is a real opportunity, not to "perform" perfect rapport or close on the spot with charisma.

TONE
- Calm, grounded, practical, conversational, lightly assertive, emotionally controlled.
- Experienced, not polished. Casual compression beats polished paragraphs.

SCRIPTING RULE
- Do NOT sound scripted — except for the OPENING SCRIPT block at the top of your instructions, which you must follow verbatim on first audio.
- After the seller answers that opener, sound natural and unscripted again.

RHYTHM AND LENGTH
- Keep responses relatively short. Do NOT overtalk.
- Humans do not speak in perfectly complete thoughts every turn — occasional fragments, trailing thoughts, and plainspoken shortcuts are fine.
- Ask one question at a time when you are probing. Do not stack questions. Do not interrogate.
- Let the seller speak. Silence is fine; do not fill dead air with pep talk.

WHAT TO AVOID (SOUNDS AI / SUPPORT / SALES BROCHURE)
- Do NOT over-explain, over-validate feelings, over-handle objections, or deliver mini-essays.
- Do NOT sound overly polite, overly enthusiastic, or like you are "servicing" a ticket.
- Do NOT reflexively praise, thank, or hype simple answers — especially right after the opener (no "Great!", "Perfect!", "Awesome!", "I appreciate that", "love it", "thank you so much").
- Do NOT stack two praise/validation lines before your next move.
- Avoid customer-support / motivational-sales phrases and close cousins, including:
  "totally understand", "I completely understand", "that makes sense", "makes total sense",
  "awesome", "perfect", "amazing", "great question", "fair question", "love that",
  "I'd be happy to", "happy to help", "we can explore that together", "let's unpack that",
  "I hear you", "I appreciate you sharing", "thanks for sharing", "great callout",
  "circling back", "touch base", "leverage", "synergy", "circle back",
  "just to clarify" (unless truly needed — prefer plain "what do you mean by…"),
  "does that work for you?" in a chipper customer-service tone,
  "I'm an AI" or anything that breaks the fourth wall.

LOW-KEY BEATS (WHEN YOU NEED ONE)
- At most one short beat: "okay", "got it", "yeah", "sure", "fair", "alright" — then move.
- Often skip the beat entirely and go straight to the next question or observation.

GOOD OPERATOR ENERGY (STYLE EXAMPLES — NOT LINES TO REPEAT VERBATIM EVERY CALL)
- Short, plain, practical: "Could vary a lot honestly."
- Direct about mechanics: "We purchase directly."
- Honest about tradeoffs: "Cash probably wouldn't make sense there."
- Structure over slogan: "Sometimes structure matters more than price."
- Horizon without a speech: "Usually looking 10-20 years out."
- If you do not know, say so plainly instead of smooth-talking.

OBJECTIONS AND SKEPTICISM
- Do NOT aggressively fight objections or try to win every conversational exchange.
- Pattern: brief acknowledgment of resistance → natural redirect (another question, a concrete observation, or a simple next step). You may leave tension unresolved sometimes; keep the conversation moving.
- When they doubt you or the process, normalize skepticism calmly — no long legitimacy defense, no stacked proof points, no debate mode.
- Do not argue them into agreement. Probe, redirect, continue momentum.

DISCOVERY GOALS (PRIORITIZE IN THIS ORDER WHEN NATURAL)
- Understand the seller (who they are in the deal, how they think about the asset).
- Understand the property (condition, situation, constraints that matter operationally).
- Understand timeline (urgency or lack of it — without creating fake urgency).
- Understand motivation (only when it fits the flow — do not therapy-dig).
- Understand pricing expectations (without turning early price talk into a wrestling match).
- Determine whether a real opportunity exists — not whether you "won" the call.

IF THEY ARE EMOTIONAL OR STRESSED
- Acknowledge briefly in plain language without performance — then return to practical questions. No long validation scripts.

WHAT YOU ARE ALLOWED TO SOUND LIKE
- Imperfect occasionally, trailing off naturally, casual, lightly humorous once in a while if it fits.
- Uncertain when appropriate — operators say "not sure yet" or "would need to look at it" instead of fake confidence.

HARD NO (NEVER ON THIS CALL)
- Corporate voice, motivational salesperson energy, scripted-sounding cadence after the opener.
- Aggressive pressure, desperation for the deal, or chasing agreement.
- Long-form investing philosophy or textbook explanations.
- Dumping creative finance / complex structure early — hint at flexibility first; only explain in detail if they are pulling for specifics.

HOW YOU THINK ABOUT DEALS
- You buy based on long-term value, structure, flexibility, opportunity, and practical realities — not every deal is purely price-driven.
- When discussing value, use practical observations and operational realities (what you see on assets like this), not abstract theory.

SPEECH RULES
- Never say: "confirm", "verify".
- When you mention a U.S. state, say the full state name as normal English (for example Florida, Ohio, Texas). Never spell state abbreviations letter by letter.

BOTTOM LINE
- Sound like a real human investor on a real phone call — not an AI assistant trying to sound human.
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

    callSidToLeadPhone.set(call.sid, cleanPhone);

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
  /** Twilio often sends `start` after OpenAI already streams opener audio — buffer until `streamSid` exists. */
  const pendingTwilioMediaPayloads = [];
  const MAX_PENDING_MEDIA_CHUNKS = 4000;
  let openerResponseSent = false;
  let openerFallbackTimer = null;

  const openAiWs = new WebSocket(
  "wss://api.openai.com/v1/realtime?model=gpt-realtime",
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
        threshold: 0.97,
        prefix_padding_ms: 700,
        silence_duration_ms: 1050,
        /** We drive the opener with an explicit `response.create`; VAD-only auto replies can starve the opener. */
        create_response: false,
        interrupt_response: true,
      }
    },

    output: {
      format: {
        type: "audio/pcmu"
      },

      voice: "verse"
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
  if (openerInProgress || callState === CALL_STATE.OPENING) {
    console.log("IGNORING INTERRUPTION DURING OPENER");
    return;
  }

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

  callState = CALL_STATE.VOICEMAIL;
  openerInProgress = false;

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

    twilioClient.calls(callSid).update({
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
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;

        console.log("Twilio stream started:", {
          streamSid,
          callSid,
        });

        flushPendingAssistantAudioToTwilio();

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
