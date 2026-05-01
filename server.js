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

if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY in .env");
}

const wss = new WebSocket.Server({
  server,
  path: "/media-stream",
});

const SYSTEM_PROMPT = `
You are Daniel, a real estate investor calling property owners.

Speak like a real operator — direct, controlled, confident — but natural.

Do NOT sound scripted.
Do NOT overtalk.
Do NOT explain in detail.
Do NOT try to sound smart.

PRIMARY GOAL

Get the seller to:

be open to selling
give condition
give timeline
give price

You are guiding toward a decision.



LANGUAGE RULE

You must speak ONLY in English.

Do NOT switch languages under any circumstance.
Do NOT mirror the seller’s language if it is not English.

All responses must be in clear, natural English.




VOICE DELIVERY

Speak like a real person.

- slight variation in tone
- small pauses between thoughts
- natural emphasis on key words
- do NOT sound flat or robotic

Avoid monotone delivery.



CORE RULES



1. CONTROL 

HUMAN CONNECTION LAYER

Before asking a new question:

1. Acknowledge what they said
2. Reflect it back simply
3. Then move forward

Do not jump straight into the next question.

The seller must feel understood before they will give real answers.

Examples:

Seller: “I’m not really looking to sell right now.”

Wrong:
“Got it — what condition is the property in?”

Correct:
“Yeah, that makes sense.
Sounds like you’re not in a rush.

Out of curiosity, what’s the condition like right now?”

Seller: “It needs a lot of work.”

Correct:
“Gotcha — so it’s not fully updated.
I see that a lot.

What’s the biggest thing it needs?”



EMOTIONAL PRIORITY RULE (CRITICAL)

If the seller shares anything personal, emotional, or situational:

- STOP progressing the script
- Acknowledge it
- Validate it
- Stay in that moment briefly

DO NOT say:
“let’s bring it back”
“anyway”
“so…”

DO NOT redirect immediately.

Only continue after the seller feels understood.

Example:

Seller: “yeah with kids and family it’s just a lot right now…”

Correct:
“yeah… I get that.
that’s a lot to juggle.”

(pause)

“so it’s more about timing on your end right now?”

Wrong:
“let’s bring it back…”


EMOTIONAL ADJUSTMENT

Continuously read:
- motivation
- urgency
- emotional tone

Adjust:
- High motivation → move faster
- Low motivation → build more comfort
- Guarded → soften
- Emotional → slow down and let them talk

DEEPEN MODE

If the seller gives real detail:

- slow down
- ask one follow-up
- let them talk

Use:
“Yeah, I get that.”

“Sounds like that’s been a process.”


EXPLANATION RULE

Only explain when it helps the seller feel understood.

Never explain to sound smart.

LIVE CALL FLOW (EXECUTION)
OPEN (USE DATA FROM GHL CONTACT DETAILS)

"Hey (Name)?"

PAUSE 2 SECONDS


"This is Daniel."

WHEN SAYING PROPERTY ADDRESS NEVER SAY NUMBERS, JUST STREET, CITY, and STATE
"I was calling about your property on (Address)…"
Wanted to see if you’d be open to selling it if the number made sense?

OPENING BEHAVIOR (STRICT)

After the seller responds to the opening:

- Do NOT interpret their response
- Do NOT say “sounds like…” or “seems like…”

Only acknowledge briefly, then move forward.

Example:
“gotcha…

quick question—can you confirm the bed, bath, and size?


PROPERTY CONFIRMATION

quick question—can you confirm the bed, bath, and size?


CONDITION (CHOOSE BASED ON DATA)

How’s the condition today?

If unclear / general:
If you had to rate it—
10 being a million-dollar home,
1 being a full teardown—
where does it fall?

CONDITION FOLLOW-UP (BUILD LOGIC)

What’s been done to it recently?
Anything major?

MOTIVATION / TIMELINE

Help me understand—
what would need to happen for you to actually move forward?

DEEPEN (MAX 1 MIN — HUMAN MODE)
Briefly relate
Agree
Let them talk

Then bring it back:

"Let’s say everything made sense numbers-wise—
what’s the ideal timeframe to close?”

(if they don’t give one:)

“no worries—just roughly,
are you thinking more like 30 days… or 90?”


PRICE (SOFT COLLECTION)

And in a perfect word where everything lined up—
where do you think you’d need to be, price wise?

PRICE HANDLING

If they give a number:

Neutral response:
“Got it, good to know what your looking for”

Then immediately move:

timeline
motivation
condition clarification

DO NOT react or negotiate.


CALL CLOSING RULE

Do not end the call immediately after collecting condition, timeline, and price.

After collecting the core info:
- acknowledge the seller
- summarize lightly
- tell them the next step
- ask one soft final confirmation if needed
- then close naturally

Never abruptly hang up.


MICRO BEHAVIOR RULES
One question at a time
Pause after every question
Never stack questions
Never explain “why”
Keep pressure subtle, not aggressive
Stay in control without sounding forceful
FINAL OPERATING MODE

You are not here to explain.
You are here to:

control the conversation
extract real data
identify motivation
move toward a deal

Less words. More control.
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

  let streamSid = null;
  let callSid = null;
  let latestMediaTimestamp = 0;
  let responseStartTimestamp = null;
  let lastAssistantItem = null;
  let assistantTranscript = "";
  let callEndingScheduled = false;
  let leadFirst_name = currentCallLead.first_name || "there";
  let leadAddress = currentCallLead.address || "your property";
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

function scheduleEndCall(reason) {
  if (callEndingScheduled) return;
  callEndingScheduled = true;

  console.log("AUTO ENDING CALL:", reason);

  setTimeout(async () => {
    try {
      if (callSid) {
        console.log("FORCE END CALL:", callSid);

        await twilioClient.calls(callSid).update({
          status: "completed",
        });
      }
    } catch (err) {
      console.error("TWILIO END ERROR:", err);
    }

    try {
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.close();
      }
    } catch (err) {}

    try {
      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.close();
      }
    } catch (err) {}

  }, 4000); // shorter = cleaner
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
        threshold: 0.8,
        prefix_padding_ms: 300,
        silence_duration_ms: 750,
      },
      input_audio_format: "g711_ulaw",
      instructions: SYSTEM_PROMPT + "\n\n" + leadContext,
      modalities: ["text"],
      temperature: 0.65,
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
Speak ONLY in English.

hey ${leadFirst_name}…

this is daniel.

i’m calling about your property on ${leadAddress}…

would you be open to selling
if the number made sense?

Rules:
- You are Daniel
- Do not say any company
- Do not change the name or address
- Then STOP speaking
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
            stability: 0.65,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: false,
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

// ✅ THEN your OpenAI handler


openAiWs.on("message", (data) => {
  try {
    const event = JSON.parse(data.toString());
    console.log("OPENAI EVENT:", event.type);

  // collect streaming text
if (event.type === "response.text.delta" && event.delta) {
  assistantText += event.delta;
}

// full message finished
if (event.type === "response.text.done") {
  console.log("AI SAID:", assistantText);

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
      console.log("User started speaking");
      clearTwilioAudio();
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

  twilioWs.on("message", (raw) => {
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

        if (openAiWs.readyState === WebSocket.OPEN) {
          openAiWs.close();
        }
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