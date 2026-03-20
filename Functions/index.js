const { onRequest } = require("firebase-functions/v2/https");
const { AccessToken } = require("livekit-server-sdk");

// ─── LiveKit credentials ──────────────────────────────────────
// Store these in Firebase environment config, not hardcoded.
// Set them once via CLI:
//   firebase functions:secrets:set APIAvBL6axx4sW2
//   firebase functions:secrets:set RJCN9j7a5Y6330Qq7fklC3NuEefSjXpEdcZAwrIhyD9A
// Then reference them below via process.env after adding to runWith secrets.
//
// For now they are set directly — replace with secrets before production.
const LIVEKIT_API_KEY    = "APIAvBL6axx4sW2";
const LIVEKIT_API_SECRET = "RJCN9j7a5Y6330Qq7fklC3NuEefSjXpEdcZAwrIhyD9A";

// ─── Token endpoint ───────────────────────────────────────────
// Called by the game client with:
//   GET /livekitToken?room=main&identity=PlayerName
//
// Returns JSON: { token: "eyJ..." }
exports.livekitToken = onRequest(
    {
        cors: true,          // Allow requests from your Firebase Hosting domain
        region: "us-central1",
    },
    async (req, res) => {
        // Only GET requests
        if (req.method !== "GET") {
            res.status(405).json({ error: "Method not allowed" });
            return;
        }

        const room     = req.query.room;
        const identity = req.query.identity;

        // Validate inputs
        if (!room || !identity) {
            res.status(400).json({ error: "Missing required params: room, identity" });
            return;
        }

        // Sanitise: room names like "main", "turret", "kitchen" etc.
        // Prefix with "subversion-" to namespace away from other LiveKit projects
        const roomName = "subversion-" + room.toLowerCase().replace(/[^a-z0-9-]/g, "");

        try {
            // Build a token valid for 6 hours (covers the longest session)
            const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
                identity:  identity,
                ttl:       "6h",
            });

            token.addGrant({
                room:             roomName,
                roomJoin:         true,
                canPublish:       true,   // Can send their own video/audio
                canSubscribe:     true,   // Can receive others' video/audio
                canPublishData:   true,
            });

            const jwt = await token.toJwt();

            res.status(200).json({
                token:    jwt,
                room:     roomName,
                identity: identity,
                url:      "wss://subversion-the-traitors-h0coqxjc.livekit.cloud",
            });

        } catch (err) {
            console.error("Token generation failed:", err);
            res.status(500).json({ error: "Failed to generate token" });
        }
    }
);
