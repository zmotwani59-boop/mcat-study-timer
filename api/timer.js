const DEFAULT_REGIONS = [
  { id: "global", label: "Global", base: "https://api.clockify.me/api/v1" },
  { id: "use2", label: "USA", base: "https://use2.clockify.me/api/v1" },
  { id: "euc1", label: "EU (Germany)", base: "https://euc1.clockify.me/api/v1" },
  { id: "euw2", label: "UK", base: "https://euw2.clockify.me/api/v1" },
  { id: "apse2", label: "Australia", base: "https://apse2.clockify.me/api/v1" },
];

function normalizeBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildRegions() {
  const configured = normalizeBase(process.env.CLOCKIFY_API_BASE);
  const regions = [];

  if (configured) {
    regions.push({ id: "configured", label: "Configured", base: configured });
  }

  for (const region of DEFAULT_REGIONS) {
    if (!regions.some((item) => item.base === region.base)) {
      regions.push(region);
    }
  }

  return regions;
}

async function requestJson(url, headers) {
  const result = await fetch(url, { headers, cache: "no-store" });
  const text = await result.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  return {
    ok: result.ok,
    status: result.status,
    data,
    text,
  };
}

async function getRunningEntry(base, workspaceId, userId, headers) {
  const query = new URLSearchParams({
    "in-progress": "true",
    page: "1",
    "page-size": "10",
  });

  const result = await requestJson(
    `${base}/workspaces/${encodeURIComponent(
      workspaceId
    )}/user/${encodeURIComponent(userId)}/time-entries?${query.toString()}`,
    headers
  );

  if (!result.ok) return result;

  const entries = Array.isArray(result.data) ? result.data : [];
  const entry =
    entries.find(
      (item) => item?.timeInterval?.start && !item?.timeInterval?.end
    ) || null;

  return { ...result, entry };
}

function validUserId(value) {
  return /^[A-Za-z0-9_-]{6,}$/.test(String(value || ""));
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store, max-age=0");

  const apiKey = process.env.CLOCKIFY_API_KEY;
  const workspaceId = process.env.CLOCKIFY_WORKSPACE_ID;

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

  const regions = buildRegions();
  const regionMap = Object.fromEntries(regions.map((region) => [region.id, region]));
  const savedRegion = regionMap[String(request.query?.region || "")];
  const savedUserId = String(request.query?.user || "");

  try {
    // Fast path after the browser has remembered the working region and user ID.
    if (savedRegion && validUserId(savedUserId)) {
      const timerResult = await getRunningEntry(
        savedRegion.base,
        workspaceId,
        savedUserId,
        headers
      );

      if (timerResult.ok) {
        const entry = timerResult.entry;
        return response.status(200).json({
          running: Boolean(entry?.timeInterval?.start),
          description: entry?.description || null,
          start: entry?.timeInterval?.start || null,
          serverNow: new Date().toISOString(),
          region: savedRegion.id,
          regionLabel: savedRegion.label,
          userId: savedUserId,
        });
      }
    }

    const diagnostics = [];

    // Discover which Clockify data region owns the workspace. Clockify API keys
    // and workspace IDs are region-specific, so a correct key can still receive
    // Access Denied from the global endpoint when the workspace is regional.
    for (const region of regions) {
      const workspacesResult = await requestJson(`${region.base}/workspaces`, headers);

      if (!workspacesResult.ok) {
        diagnostics.push({
          region: region.id,
          workspaceStatus: workspacesResult.status,
        });
        continue;
      }

      const workspaces = Array.isArray(workspacesResult.data)
        ? workspacesResult.data
        : [];
      const workspace = workspaces.find((item) => item?.id === workspaceId);

      if (!workspace) {
        diagnostics.push({
          region: region.id,
          workspaceStatus: 200,
          workspaceMatched: false,
        });
        continue;
      }

      const userResult = await requestJson(`${region.base}/user`, headers);

      if (!userResult.ok || !userResult.data?.id) {
        diagnostics.push({
          region: region.id,
          workspaceMatched: true,
          userStatus: userResult.status,
        });
        continue;
      }

      const userId = userResult.data.id;
      const timerResult = await getRunningEntry(
        region.base,
        workspaceId,
        userId,
        headers
      );

      if (!timerResult.ok) {
        diagnostics.push({
          region: region.id,
          workspaceMatched: true,
          timerStatus: timerResult.status,
          timerDetail: timerResult.text,
        });
        continue;
      }

      const entry = timerResult.entry;
      return response.status(200).json({
        running: Boolean(entry?.timeInterval?.start),
        description: entry?.description || null,
        start: entry?.timeInterval?.start || null,
        serverNow: new Date().toISOString(),
        region: region.id,
        regionLabel: region.label,
        userId,
      });
    }

    const matchedWorkspace = diagnostics.find((item) => item.workspaceMatched);

    if (matchedWorkspace?.timerStatus === 403) {
      return response.status(403).json({
        error:
          "Clockify found this workspace but denied access to its time entries. Regenerate the API key while logged into the same Clockify account that owns the timer, then replace CLOCKIFY_API_KEY in Vercel and redeploy.",
        resetConnection: true,
        diagnostics,
      });
    }

    return response.status(403).json({
      error:
        "The Clockify API key could not access the configured workspace in Global, USA, EU, UK, or Australia. Check that the API key and workspace ID belong to the same Clockify account.",
      resetConnection: true,
      diagnostics,
    });
  } catch (error) {
    return response.status(502).json({
      error: error instanceof Error ? error.message : "Unknown Clockify error",
      resetConnection: true,
    });
  }
}
