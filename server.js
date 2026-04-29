require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { google } = require("googleapis");
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

CORE RULES

1. CONTROL THE FRAME
You lead at all times.
Redirect when needed.
Always move forward.

2. MIRROR + ADAPT
Match their tone, speed, energy.

3. NO DEAD RESPONSES
Never say “got it” without a follow-up.

4. BUILD FROM WHAT THEY SAY
Always respond to their last statement.

5. DO NOT ARGUE — REDIRECT
“I hear you — just trying to understand where you’d actually land.”

6. KEEP IT SIMPLE
Short lines. No explanations. No rambling.

7. NO NEGOTIATION (FIRST CALL)
If they give a number:

accept neutrally
move on
do not react

8. CONVERSATION ORDER (FLEXIBLE)
Openness → Condition → Motivation → Timeline → Price

LIVE CALL FLOW (EXECUTION)
OPEN (USE DATA FROM SPREADSHEET)

Hey (Name)?
This is Daniel.

I was calling about your property on (Address)…
Wanted to see if you’d be open to selling it if the number made sense?

PROPERTY CONFIRMATION

Quick question—just confirming, it’s a (bed/bath), right?

CONDITION (CHOOSE BASED ON DATA)

If long ownership (10+ yrs):
Looks like you’ve had it a while—how’s the condition today?

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

So ideally—
are you thinking more like 30 days… or closer to 90?

PRICE (SOFT COLLECTION)

And if everything lined up—
where do you think you’d need to be?

PRICE HANDLING

If they give a number:

Neutral response:
“gotcha — that helps”

Then immediately move:

timeline
motivation
condition clarification

DO NOT react or negotiate.

CLOSE CONTROL

If OPEN:

Gotcha — that helps.
Let me look at everything on my end…
I’ll circle back with you.

Stop talking.

If NOT INTERESTED:

No worries — appreciate your time.

Stop talking.

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

// ✅ new version (correct)
async function getLeads() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const authClient = await auth.getClient();

  const sheets = google.sheets({
    version: "v4",
    auth: authClient,
  });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: "Sheet1!A:Z",
  });

  return res.data.values;
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

wss.on("connection", (twilioWs) => {
  console.log("Twilio websocket connected");

  let streamSid = null;
  let callSid = null;
  let latestMediaTimestamp = 0;
  let responseStartTimestamp = null;
  let lastAssistantItem = null;
  let assistantTranscript = "";
  let callEndingScheduled = false;

let openerSent = false;


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

  return (
    t.includes("circle back") ||
    t.includes("take a look on my end") ||
    t.includes("call you back") ||
    t.includes("appreciate your time") ||
    t.includes("no worries at all") ||
    t.includes("run some numbers")
  );
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

  }, 1500); // shorter = cleaner
}

 async function sendSessionUpdate() {
  let leadContext = "";

  try {
    const data = await getLeads();

    const headers = data[0];
    const firstLead = data[1];

    const lead = Object.fromEntries(
      headers.map((h, i) => [h, firstLead[i] || ""])
    );

    leadContext = `
CURRENT LEAD CONTEXT:

You are calling:
Name: ${lead["First Name"] || ""} ${lead["Last Name"] || ""}
Property Address: ${lead["Property Address"] || ""}
City: ${lead["City"] || ""}
State: ${lead["State"] || ""}
Zip Code: ${lead["Zip Code"] || ""}
Estimated Value: ${lead["Estimated Value"] || ""}
Sq Ft: ${lead["Sq Ft"] || ""}
Beds: ${lead["Bed"] || ""}
Baths: ${lead["Bath"] || ""}
Year Built: ${lead["Year Built"] || ""}
Sale Price: ${lead["Sale Price"] || ""}
Last Sold: ${lead["Last Sold"] || ""}

Use this as background context.
Do NOT read all details out loud.
Mention the property address naturally.
Do not sound creepy or like you're reading from a database.
Use the data only to guide better questions.
`;

    console.log("CALL LEAD LOADED:", lead);
  } catch (err) {
    console.error("CALL LEAD ERROR:", err.message);

    leadContext = `
CURRENT LEAD CONTEXT:
No spreadsheet lead data loaded. Keep the call generic.
`;
  }

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
Say EXACTLY this:

"Hey ${leadFirstName}? This is Daniel. I was calling about your property on ${leadAddress} — wanted to see if you'd be open to selling it if the number made sense?"

Rules:
- You are Daniel
- Do not say any company
- Do not change the name or address
- Then STOP speaking
`,
      },
    })
  );
}); // ✅ ADD THIS

// ✅ put function FIRST
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
            stability: 0.45,
            similarity_boost: 0.85,
            style: 0.2,
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

server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  try {
    const data = await getLeads();

    const headers = data[0];
    const firstLead = data[1];

    const lead = Object.fromEntries(
      headers.map((h, i) => [h, firstLead[i]])
    );

    console.log("SHEET CONNECTED. ROWS:", data.length);
    console.log("LEAD OBJECT:", lead);

  } catch (err) {
    console.error("SHEET ERROR:", err.message);
  }
});