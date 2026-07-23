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
  if (configured) regions.push({ id: "configured", label: "Configured", base: configured });
  for (const region of DEFAULT_REGIONS) {
    if (!regions.some((item) => item.base === region.base)) regions.push(region);
  }
  return regions;
}

async function requestJson(url, headers) {
  const result = await fetch(url, { headers, cache: "no-store" });
  const text = await result.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: result.ok, status: result.status, data, text };
}

async function getRecentEntries(base, workspaceId, userId, headers) {
  const query = new URLSearchParams({ page: "1", "page-size": "100" });
  const result = await requestJson(
    `${base}/workspaces/${encodeURIComponent(workspaceId)}/user/${encodeURIComponent(userId)}/time-entries?${query.toString()}`,
    headers
  );
  if (!result.ok) return result;
  const entries = Array.isArray(result.data) ? result.data : [];
  const activeEntry = entries.find(
    (item) => item?.timeInterval?.start && !item?.timeInterval?.end
  ) || null;
  return { ...result, entries, activeEntry };
}

function validId(value) {
  return /^[A-Za-z0-9_-]{6,}$/.test(String(value || ""));
}

function uniqueWorkspaceCandidates(workspaces, user, preferredWorkspaceId) {
  const byId = new Map();
  for (const workspace of workspaces) {
    if (workspace?.id) byId.set(workspace.id, workspace);
  }
  for (const id of [preferredWorkspaceId, user?.activeWorkspace, user?.defaultWorkspace]) {
    if (id && !byId.has(id)) byId.set(id, { id, name: null });
  }
  const priority = [preferredWorkspaceId, user?.activeWorkspace, user?.defaultWorkspace].filter(Boolean);
  return [...byId.values()].sort((a, b) => {
    const ai = priority.indexOf(a.id);
    const bi = priority.indexOf(b.id);
    return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) -
      (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
  });
}

function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
  };
}

function zonedDateTimeToUtc(parts, timeZone) {
  let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
  for (let i = 0; i < 3; i += 1) {
    const actual = getZonedParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const targetAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
    guess += targetAsUtc - actualAsUtc;
  }
  return guess;
}

function todayBounds(now, timeZone) {
  const local = getZonedParts(now, timeZone);
  const startMs = zonedDateTimeToUtc({ year: local.year, month: local.month, day: local.day }, timeZone);
  const nextCalendar = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const endMs = zonedDateTimeToUtc({
    year: nextCalendar.getUTCFullYear(),
    month: nextCalendar.getUTCMonth() + 1,
    day: nextCalendar.getUTCDate(),
  }, timeZone);
  return { startMs, endMs };
}

function totalTodayMs(entries, now, timeZone) {
  const { startMs: dayStart, endMs: dayEnd } = todayBounds(now, timeZone);
  return entries.reduce((total, entry) => {
    const start = Date.parse(entry?.timeInterval?.start || "");
    const end = entry?.timeInterval?.end ? Date.parse(entry.timeInterval.end) : now.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return total;
    const clippedStart = Math.max(start, dayStart);
    const clippedEnd = Math.min(end, dayEnd, now.getTime());
    return clippedEnd > clippedStart ? total + (clippedEnd - clippedStart) : total;
  }, 0);
}

function cleanDescription(value) {
  if (value == null) return null;
  let parsed = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { parsed = JSON.parse(trimmed); } catch { return trimmed; }
    } else {
      return trimmed;
    }
  }
  if (typeof parsed === "object") {
    const rich = parsed?.title || parsed?.rich_text;
    if (Array.isArray(rich)) {
      const text = rich.map((item) => item?.plain_text || item?.text?.content || "").join("").trim();
      if (text) return text;
    }
    if (typeof parsed?.plain_text === "string") return parsed.plain_text.trim() || null;
  }
  return String(value);
}

function successPayload({ entries, activeEntry, region, userId, workspace, timeZone }) {
  const now = new Date();
  return {
    running: Boolean(activeEntry?.timeInterval?.start),
    description: cleanDescription(activeEntry?.description) || null,
    activeStart: activeEntry?.timeInterval?.start || null,
    totalTodayMs: totalTodayMs(entries, now, timeZone),
    serverNow: now.toISOString(),
    timeZone,
    region: region.id,
    regionLabel: region.label,
    userId,
    workspaceId: workspace.id,
    workspaceName: workspace.name || null,
  };
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  const apiKey = process.env.CLOCKIFY_API_KEY;
  const preferredWorkspaceId = process.env.CLOCKIFY_WORKSPACE_ID;
  const timeZone = process.env.STUDY_TIME_ZONE || "America/New_York";
  if (!apiKey) return response.status(500).json({ error: "Missing CLOCKIFY_API_KEY in Vercel environment variables." });

  const headers = { "X-Api-Key": apiKey, Accept: "application/json" };
  const regions = buildRegions();
  const regionMap = Object.fromEntries(regions.map((region) => [region.id, region]));
  const savedRegion = regionMap[String(request.query?.region || "")];
  const savedUserId = String(request.query?.user || "");
  const savedWorkspaceId = String(request.query?.workspace || "");

  try {
    if (savedRegion && validId(savedUserId) && validId(savedWorkspaceId)) {
      const result = await getRecentEntries(savedRegion.base, savedWorkspaceId, savedUserId, headers);
      if (result.ok) {
        return response.status(200).json(successPayload({
          entries: result.entries, activeEntry: result.activeEntry, region: savedRegion,
          userId: savedUserId, workspace: { id: savedWorkspaceId, name: null }, timeZone,
        }));
      }
    }

    const diagnostics = [];
    for (const region of regions) {
      const userResult = await requestJson(`${region.base}/user`, headers);
      if (!userResult.ok || !userResult.data?.id) {
        diagnostics.push({ region: region.id, userStatus: userResult.status });
        continue;
      }
      const user = userResult.data;
      const userId = user.id;
      const workspacesResult = await requestJson(`${region.base}/workspaces`, headers);
      if (!workspacesResult.ok) {
        diagnostics.push({ region: region.id, userStatus: 200, workspacesStatus: workspacesResult.status });
        continue;
      }
      const workspaces = Array.isArray(workspacesResult.data) ? workspacesResult.data : [];
      const candidates = uniqueWorkspaceCandidates(workspaces, user, preferredWorkspaceId);
      let firstReadable = null;
      for (const workspace of candidates) {
        const result = await getRecentEntries(region.base, workspace.id, userId, headers);
        if (!result.ok) {
          diagnostics.push({ region: region.id, workspaceId: workspace.id, timerStatus: result.status });
          continue;
        }
        if (!firstReadable) firstReadable = { workspace, result };
        if (result.activeEntry) {
          return response.status(200).json(successPayload({
            entries: result.entries, activeEntry: result.activeEntry, region, userId, workspace, timeZone,
          }));
        }
      }
      if (firstReadable) {
        return response.status(200).json(successPayload({
          entries: firstReadable.result.entries, activeEntry: null, region, userId,
          workspace: firstReadable.workspace, timeZone,
        }));
      }
    }

    return response.status(403).json({
      error: "Clockify could not read any workspace available to this API key.",
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
