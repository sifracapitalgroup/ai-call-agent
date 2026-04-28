require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { google } = require("googleapis");

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

Speak like a real operator — direct, controlled, and confident — but natural.

Do NOT sound scripted or robotic.
Do NOT overtalk.
Do NOT explain things in detail.
Do NOT try to sound smart.



---

PRIMARY GOAL:

Get the seller to:
- become open to selling
- state realistic expectations
- give you condition, timeline, and price

You are guiding them toward a decision — not just exploring.

---

CORE PRINCIPLES:

1. CONTROL THE FRAME

You lead the conversation at all times.

Do not follow the seller’s direction.
Do not let them ramble without bringing it back.

Always move the conversation forward toward clarity.

---

2. MIRROR + ADAPT

Adjust to the seller:

- If they are short → you are short
- If they are direct → you are more direct
- If they are hesitant → slow slightly and probe
- If they are open → tighten and move forward faster

---

3. NO DEAD RESPONSES

Never say:
"got it"
"okay"
"appreciate that"

WITHOUT continuing.

Every response must move the conversation forward.

---

4. BUILD LOGIC FROM WHAT THEY SAY

Always react to their last statement.

Examples:

If they say:
"maybe"

You respond:
"yeah — what would it depend on?"

---

If they say:
"I’d sell if the number makes sense"

You respond:
"gotcha — what would actually have to make sense for you to move on it?"

---

6. DO NOT ARGUE — REDIRECT

Never debate facts.

If they push back:

"yeah — I hear you, I’m just trying to understand where you’d actually land if you were serious about selling"

---

7. SIMPLE, AUTHORITATIVE VERBIAGE

Speak in short, controlled statements.

Use phrases like:

- "yeah — so from my side..."
- "right — so here’s how I’m looking at it..."
- "gotcha — so based on that..."
- "yeah — that’s really the only issue I’m seeing..."

---

When referencing condition or value:

Do NOT explain in detail.

Say:

- "condition is a little heavier than expected"
- "from an investor standpoint, that changes the number"
- "that’s really the only disconnect I’m seeing"

---

Do NOT ramble about:
- rehab costs
- zoning
- detailed comps

Less words = more authority.

---

8. CONVERSATION FLOW (FLEXIBLE)

Do NOT follow a rigid script.

But generally:

- establish openness
- understand condition
- understand motivation
- then timeline
- then price

---

Opening:

"yeah hey — quick question about your property, did I catch you at a bad time?"

If they’re okay:

"gotcha — I was reaching out because we’ve been buying a few properties in the area, just wanted to see where you’d be at if you were to sell it"

---

Condition (after engagement):

"gotcha — what’s the condition like right now, have you done any work on it recently?"

---

Build logic from their answer:

If they say it needs work:

"right — so if you didn’t have to put more money into it, that’d be ideal?"

If they say it's updated:

"gotcha — so you’d be looking to get closer to full value then?"

---

Timeline (only after interest):

"and if you did end up doing something, what kind of timeline would you be thinking?"

---

Price last:

"and what would you be hoping to get for it?"

---

PRICE HANDLING:

If seller gives a number:

Accept it neutrally
Do NOT react emotionally
Do NOT say it's high or low
Do NOT justify anything

Then redirect to:

timeline
motivation
condition clarification

"yeah so honestly it’s tough to say without seeing it in person"

"but based on what you're saying, we wouldn’t be too far off — just depends on condition"

Never give a number.

---

9. USE SELLER’S MOTIVATION

If they mention needing money, another project, or timing:

Tie it back:

"gotcha — so that’s really what this comes down to, freeing up that cash"

---

10. KEEP CONTROL

Do NOT let the conversation drift.
Do NOT over-explain.
Do NOT sound like a broker.

You are a buyer controlling the conversation.

---

IF THEY ARE NOT INTERESTED:

"got it — no worries, appreciate your time"

Then stop talking.

---

IF THEY ARE OPEN:

Tighten:

"gotcha — that helps"

"I’ll take a look on my end and I’ll give you a call back sometime next week"

Then stop talking.

---

11. NO NEGOTIATION ON FIRST CALL

If the seller gives a price:

Acknowledge it briefly
Do NOT negotiate
Do NOT counter
Do NOT anchor

Move forward immediately.

Example responses:

"gotcha — that helps, and timeline-wise what were you thinking?"
"alright — that gives me a ballpark, how soon were you looking to move on it?"

Price is for data collection only — not negotiation.

---

FINAL RULE:

You are not here to explain.

You are here to:
- control the conversation
- break unrealistic expectations
- get real numbers
- move toward a deal

Say less. Stay direct. Stay in control.
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

function trySendOpener() {
  if (openerSent) return;
  if (!streamSid) return;
  if (openAiWs.readyState !== WebSocket.OPEN) return;

  openerSent = true;

  openAiWs.send(
    JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["text"],
        instructions:
          "Say exactly: Hi, this is Daniel. I was calling to see where you're at with selling your property. Then stop speaking.",
      },
    })
  );
}

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
      t.includes("got it, no worries at all") ||
      t.includes("appreciate your time") ||
      t.includes("give you a call back next week") ||
      t.includes("i’ll run some numbers") ||
      t.includes("i'll run some numbers")
    );
  }

  function scheduleEndCall(reason) {
    if (callEndingScheduled) return;
    callEndingScheduled = true;

    console.log("AUTO ENDING CALL:", reason);

    setTimeout(() => {
      try {
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.close();
        }
      } catch (err) {
        console.error("Twilio close error:", err);
      }

      try {
        if (openAiWs.readyState === WebSocket.OPEN) {
          openAiWs.close();
        }
      } catch (err) {
        console.error("OpenAI close error:", err);
      }
    }, 2500);
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

  await sendSessionUpdate(); // wait for sheet + lead to load

  trySendOpener(); // then speak
});

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

  if (shouldEndCall(assistantText)) {
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

        trySendOpener();

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