let cachedUserId = null;

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store, max-age=0");

  const apiKey = process.env.CLOCKIFY_API_KEY;
  const workspaceId = process.env.CLOCKIFY_WORKSPACE_ID;
  const configuredUserId = process.env.CLOCKIFY_USER_ID;
  const apiBase =
    process.env.CLOCKIFY_API_BASE || "https://api.clockify.me/api/v1";

  if (!apiKey || !workspaceId) {
    return response.status(500).json({
      error:
        "Missing CLOCKIFY_API_KEY or CLOCKIFY_WORKSPACE_ID in Vercel environment variables.",
    });
  }

  const headers = {
    "X-Api-Key": apiKey,
    Accept: "application/json",
  };

  try {
    let userId = configuredUserId || cachedUserId;

    // The workspace-wide in-progress endpoint can require elevated permissions.
    // Resolve the API key owner's user ID and request only that user's entries.
    if (!userId) {
      const userResponse = await fetch(`${apiBase}/user`, {
        headers,
        cache: "no-store",
      });

      if (!userResponse.ok) {
        const detail = await userResponse.text();
        throw new Error(
          `Clockify user lookup failed (${userResponse.status}): ${detail}`
        );
      }

      const user = await userResponse.json();
      userId = user?.id;

      if (!userId) {
        throw new Error("Clockify user lookup returned no user ID.");
      }

      cachedUserId = userId;
    }

    const query = new URLSearchParams({
      "in-progress": "true",
      page: "1",
      "page-size": "10",
    });

    const timerResponse = await fetch(
      `${apiBase}/workspaces/${encodeURIComponent(
        workspaceId
      )}/user/${encodeURIComponent(userId)}/time-entries?${query.toString()}`,
      { headers, cache: "no-store" }
    );

    if (!timerResponse.ok) {
      const detail = await timerResponse.text();
      throw new Error(
        `Clockify timer lookup failed (${timerResponse.status}): ${detail}`
      );
    }

    const entries = await timerResponse.json();
    const entry = Array.isArray(entries)
      ? entries.find(
          (item) =>
            item?.timeInterval?.start && !item?.timeInterval?.end
        ) || null
      : null;

    return response.status(200).json({
      running: Boolean(entry?.timeInterval?.start),
      description: entry?.description || null,
      start: entry?.timeInterval?.start || null,
      serverNow: new Date().toISOString(),
    });
  } catch (error) {
    return response.status(502).json({
      error: error instanceof Error ? error.message : "Unknown Clockify error",
    });
  }
}
