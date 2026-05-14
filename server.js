require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { REST, Routes } = require("discord.js");

const app = express();

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ADMIN_WHITELIST_USER_IDS = parseList(process.env.ADMIN_WHITELIST_USER_IDS);

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const DISCORD_LOG_CHANNEL_ID = process.env.DISCORD_LOG_CHANNEL_ID;

const LUARMOR_API_KEY = process.env.LUARMOR_API_KEY;
const LUARMOR_PROJECT_ID = process.env.LUARMOR_PROJECT_ID;
const LUARMOR_BASE_URL = process.env.LUARMOR_BASE_URL || "https://api.luarmor.net";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const discordRest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

const allowedOrigins = [
  "https://dragonnotifier.com",
  "https://www.dragonnotifier.com",
  "https://litecoin-mall-hub.lovable.app",
  "https://id-preview--1050765f-d1e1-4c7e-ad91-d3fb5aec09f0.lovable.app"
];

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    if (origin.endsWith(".lovable.app")) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "1mb" }));

function parseList(value) {
  if (!value) return [];

  return value
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

function ok(extra = {}) {
  return {
    success: true,
    ...extra
  };
}

function fail(res, status, message) {
  return res.status(status).json({
    error: message
  });
}

function requireField(body, field) {
  const value = body[field];

  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required field: ${field}`);
  }

  return value;
}

async function verifyAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return fail(res, 401, "Missing Authorization Bearer token");
    }

    const token = authHeader.replace("Bearer ", "").trim();

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data || !data.user) {
      return fail(res, 401, "Invalid or expired Supabase token");
    }

    const user = data.user;

    if (!ADMIN_WHITELIST_USER_IDS.includes(user.id)) {
      return fail(res, 403, "Not whitelisted");
    }

    req.adminUser = user;

    return next();
  } catch (error) {
    console.error("Auth error:", error);
    return fail(res, 500, "Auth check failed");
  }
}

async function sendDiscordLog(message) {
  if (!DISCORD_LOG_CHANNEL_ID) return;

  try {
    await discordRest.post(
      Routes.channelMessages(DISCORD_LOG_CHANNEL_ID),
      {
        body: {
          content: message
        }
      }
    );
  } catch (error) {
    console.error("Failed to send Discord log:", error);
  }
}

async function discordAnnounce(channelId, message) {
  return discordRest.post(
    Routes.channelMessages(channelId),
    {
      body: {
        content: message
      }
    }
  );
}

async function discordBan(discordId, reason) {
  return discordRest.put(
    Routes.guildBan(DISCORD_GUILD_ID, discordId),
    {
      body: {
        delete_message_seconds: 0
      },
      reason
    }
  );
}

async function discordUnban(discordId, reason) {
  return discordRest.delete(
    Routes.guildBan(DISCORD_GUILD_ID, discordId),
    {
      reason
    }
  );
}

async function callLuarmor(actionName, payload) {
  if (!LUARMOR_API_KEY) {
    throw new Error("LUARMOR_API_KEY is missing");
  }

  if (!LUARMOR_PROJECT_ID) {
    throw new Error("LUARMOR_PROJECT_ID is missing");
  }

  /*
    IMPORTANT:
    Luarmor endpoint names depend on your Luarmor API docs/dashboard.

    This function is intentionally centralized.
    Once you give me the real Luarmor endpoint docs, we only edit this function
    instead of editing every route.
  */

  const response = await fetch(`${LUARMOR_BASE_URL}/YOUR_LUARMOR_ENDPOINT_HERE`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LUARMOR_API_KEY}`
    },
    body: JSON.stringify({
      project_id: LUARMOR_PROJECT_ID,
      action: actionName,
      ...payload
    })
  });

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      message: text
    };
  }

  if (!response.ok) {
    throw new Error(data.error || data.message || `Luarmor request failed with ${response.status}`);
  }

  return data;
}

app.get("/", (req, res) => {
  return res.json({
    success: true,
    message: "Dragon Notifier Admin API is online"
  });
});

app.get("/health", (req, res) => {
  return res.json({
    success: true,
    status: "online"
  });
});

app.use("/api/admin", verifyAdmin);

app.post("/api/admin/user/details", async (req, res) => {
  try {
    const discordId = requireField(req.body, "discordId");

    return res.json(ok({
      user: {
        discordId,
        note: "Backend is online. Connect your database here for real user details."
      }
    }));
  } catch (error) {
    return fail(res, 400, error.message);
  }
});

app.post("/api/admin/user/balance/adjust", async (req, res) => {
  try {
    const discordId = requireField(req.body, "discordId");
    const amount = requireField(req.body, "amount");
    const reason = req.body.reason || "Admin adjustment";

    await sendDiscordLog(
      `Balance adjusted\nDiscord ID: ${discordId}\nAmount: ${amount}\nReason: ${reason}\nAdmin: ${req.adminUser.id}`
    );

    return res.json(ok({
      discordId,
      amount,
      reason
    }));
  } catch (error) {
    return fail(res, 400, error.message);
  }
});

app.post("/api/admin/user/subscription/give-hours", async (req, res) => {
  try {
    const discordId = requireField(req.body, "discordId");
    const hours = requireField(req.body, "hours");
    const reason = req.body.reason || "Admin gave hours";

    await sendDiscordLog(
      `Subscription hours given\nDiscord ID: ${discordId}\nHours: ${hours}\nReason: ${reason}\nAdmin: ${req.adminUser.id}`
    );

    return res.json(ok({
      discordId,
      hours,
      reason
    }));
  } catch (error) {
    return fail(res, 400, error.message);
  }
});

app.post("/api/admin/user/subscription/remove-hours", async (req, res) => {
  try {
    const discordId = requireField(req.body, "discordId");
    const hours = requireField(req.body, "hours");
    const reason = req.body.reason || "Admin removed hours";

    await sendDiscordLog(
      `Subscription hours removed\nDiscord ID: ${discordId}\nHours: ${hours}\nReason: ${reason}\nAdmin: ${req.adminUser.id}`
    );

    return res.json(ok({
      discordId,
      hours,
      reason
    }));
  } catch (error) {
    return fail(res, 400, error.message);
  }
});

app.post("/api/admin/luarmor/generate-key", async (req, res) => {
  try {
    const discordId = requireField(req.body, "discordId");
    const hours = requireField(req.body, "hours");
    const plan = req.body.plan || "default";
    const note = req.body.note || "Generated from admin panel";

    const luarmor = await callLuarmor("generate-key", {
      discord_id: discordId,
      hours,
      plan,
      note
    });

    await sendDiscordLog(
      `Luarmor key generated\nDiscord ID: ${discordId}\nPlan: ${plan}\nHours: ${hours}\nAdmin: ${req.adminUser.id}`
    );

    return res.json(ok({
      luarmor
    }));
  } catch (error) {
    return fail(res, 400, error.message);
  }
});

app.post("/api/admin/luarmor/grant-private-key", async (req, res) => {
  try {
    const discordId = requireField(req.body, "discordId");
    const hours = requireField(req.body, "hours");
    const plan = req.body.plan || "private";
    const note = req.body.note || "Private key granted from admin panel";

    const luarmor = await callLuarmor("grant-private-key", {
      discord_id: discordId,
      hours,
      plan,
      note
    });

    await sendDiscordLog(
      `Private Luarmor key granted\nDiscord ID: ${discordId}\nPlan: ${plan}\nHours: ${hours}\nAdmin: ${req.adminUser.id}`
    );

    return res.json(ok({
      luarmor
    }));
  } catch (error) {
    return fail(res, 400, error.message);
  }
});

app.post("/api/admin/luarmor/delete-key", async (req, res) => {
  try {
    const discordId = requireField(req.body, "discordId");
    const reason = req.body.reason || "Key deleted by admin";

    const luarmor = await callLuarmor("delete-key", {
      discord_id: discordId,
      reason
    });

    await sendDiscordLog(
      `Luarmor key deleted\nDiscord ID: ${discordId}\nReason: ${reason}\nAdmin: ${req.adminUser.id}`
    );

    return res.json(ok({
      luarmor
    }));
  } catch (error) {
    return fail(res, 400, error.message);
  }
});

app.post("/api/admin/luarmor/reset-hwid", async (req, res) => {
  try {
    const discordId = requireField(req.body, "discordId");
    const reason = req.body.reason || "HWID reset by admin";

    const luarmor = await callLuarmor("reset-hwid", {
      discord_id: discordId,
      reason
    });

    await sendDiscordLog(
      `Luarmor HWID reset\nDiscord ID: ${discordId}\nReason: ${reason}\nAdmin: ${req.adminUser.id}`
    );

    return res.json(ok({
      luarmor
    }));
  } catch (error) {
    return fail(res, 400, error.message);
  }
});

app.post("/api/admin/luarmor/blacklist", async (req, res) => {
  try {
    const discordId = requireField(req.body, "discordId");
    const reason = req.body.reason || "Blacklisted by admin";

    const luarmor = await callLuarmor("blacklist", {
      discord_id: discordId,
      reason
    });

    await sendDiscordLog(
      `Luarmor user blacklisted\nDiscord ID: ${discordId}\nReason: ${reason}\nAdmin: ${req.adminUser.id}`
    );

    return res.json(ok({
      luarmor
    }));
  } catch (error) {
    return fail(res, 400, error.message);
  }
});

app.post("/api/admin/luarmor/unblacklist", async (req, res) => {
  try {
    const discordId = requireField(req.body, "discordId");
    const reason = req.body.reason || "Removed from blacklist by admin";

    const luarmor = await callLuarmor("unblacklist", {
      discord_id: discordId,
      reason
    });

    await sendDiscordLog(
      `Luarmor user unblacklisted\nDiscord ID: ${discordId}\nReason: ${reason}\nAdmin: ${req.adminUser.id}`
    );

    return res.json(ok({
      luarmor
    }));
  } catch (error) {
    return fail(res, 400, error.message);
  }
});

app.post("/api/admin/user/ban", async (req, res) => {
  try {
    const discordId = requireField(req.body, "discordId");
    const reason = req.body.reason || "Banned from admin panel";

    await discordBan(discordId, reason);

    await sendDiscordLog(
      `User banned from Discord\nDiscord ID: ${discordId}\nReason: ${reason}\nAdmin: ${req.adminUser.id}`
    );

    return res.json(ok({
      discordId,
      reason
    }));
  } catch (error) {
    return fail(res, 400, error.message);
  }
});

app.post("/api/admin/user/unban", async (req, res) => {
  try {
    const discordId = requireField(req.body, "discordId");
    const reason = req.body.reason || "Unbanned from admin panel";

    await discordUnban(discordId, reason);

    await sendDiscordLog(
      `User unbanned from Discord\nDiscord ID: ${discordId}\nReason: ${reason}\nAdmin: ${req.adminUser.id}`
    );

    return res.json(ok({
      discordId,
      reason
    }));
  } catch (error) {
    return fail(res, 400, error.message);
  }
});

app.post("/api/admin/discord/announce", async (req, res) => {
  try {
    const channelId = requireField(req.body, "channelId");
    const message = requireField(req.body, "message");

    await discordAnnounce(channelId, message);

    await sendDiscordLog(
      `Discord announcement sent\nChannel ID: ${channelId}\nAdmin: ${req.adminUser.id}`
    );

    return res.json(ok({
      channelId
    }));
  } catch (error) {
    return fail(res, 400, error.message);
  }
});

app.use((req, res) => {
  return fail(res, 404, "Endpoint not found");
});

app.listen(PORT, () => {
  console.log(`Dragon Notifier Admin API running on port ${PORT}`);
});
