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

function validId(value) {
  return /^[A-Za-z0-9_-]{6,}$/.test(String(value || ""));
}

function uniqueWorkspaceCandidates(workspaces, user, preferredWorkspaceId) {
  const byId = new Map();

  for (const workspace of workspaces) {
    if (workspace?.id) byId.set(workspace.id, workspace);
  }

  for (const id of [
    preferredWorkspaceId,
    user?.activeWorkspace,
    user?.defaultWorkspace,
  ]) {
    if (id && !byId.has(id)) {
      byId.set(id, { id, name: null });
    }
  }

  const priority = [
    preferredWorkspaceId,
    user?.activeWorkspace,
    user?.defaultWorkspace,
  ].filter(Boolean);

  return [...byId.values()].sort((a, b) => {
    const ai = priority.indexOf(a.id);
    const bi = priority.indexOf(b.id);
    const ar = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
    const br = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
    return ar - br;
  });
}

function successPayload({ entry, region, userId, workspace }) {
  return {
    running: Boolean(entry?.timeInterval?.start),
    description: entry?.description || null,
    start: entry?.timeInterval?.start || null,
    serverNow: new Date().toISOString(),
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

  if (!apiKey) {
    return response.status(500).json({
      error: "Missing CLOCKIFY_API_KEY in Vercel environment variables.",
    });
  }

  const headers = {
    "X-Api-Key": apiKey,
    Accept: "application/json",
  };

  const regions = buildRegions();
  const regionMap = Object.fromEntries(
    regions.map((region) => [region.id, region])
  );

  const savedRegion = regionMap[String(request.query?.region || "")];
  const savedUserId = String(request.query?.user || "");
  const savedWorkspaceId = String(request.query?.workspace || "");

  try {
    // Fast path: one Clockify request after the widget remembers its working
    // region, user, and workspace.
    if (
      savedRegion &&
      validId(savedUserId) &&
      validId(savedWorkspaceId)
    ) {
      const timerResult = await getRunningEntry(
        savedRegion.base,
        savedWorkspaceId,
        savedUserId,
        headers
      );

      if (timerResult.ok) {
        return response.status(200).json(
          successPayload({
            entry: timerResult.entry,
            region: savedRegion,
            userId: savedUserId,
            workspace: { id: savedWorkspaceId, name: null },
          })
        );
      }
    }

    const diagnostics = [];

    // Locate the data region accepted by the API key, discover every workspace
    // available to that user, then find the workspace that contains a running
    // timer. CLOCKIFY_WORKSPACE_ID is only a preference and is no longer
    // required or trusted as the source of truth.
    for (const region of regions) {
      const userResult = await requestJson(`${region.base}/user`, headers);

      if (!userResult.ok || !userResult.data?.id) {
        diagnostics.push({
          region: region.id,
          userStatus: userResult.status,
        });
        continue;
      }

      const user = userResult.data;
      const userId = user.id;
      const workspacesResult = await requestJson(
        `${region.base}/workspaces`,
        headers
      );

      if (!workspacesResult.ok) {
        diagnostics.push({
          region: region.id,
          userStatus: 200,
          workspacesStatus: workspacesResult.status,
        });
        continue;
      }

      const workspaces = Array.isArray(workspacesResult.data)
        ? workspacesResult.data
        : [];
      const candidates = uniqueWorkspaceCandidates(
        workspaces,
        user,
        preferredWorkspaceId
      );

      if (!candidates.length) {
        diagnostics.push({
          region: region.id,
          userStatus: 200,
          workspacesStatus: 200,
          workspaceCount: 0,
        });
        continue;
      }

      let firstReadableWorkspace = null;

      for (const workspace of candidates) {
        const timerResult = await getRunningEntry(
          region.base,
          workspace.id,
          userId,
          headers
        );

        if (!timerResult.ok) {
          diagnostics.push({
            region: region.id,
            workspaceId: workspace.id,
            timerStatus: timerResult.status,
          });
          continue;
        }

        if (!firstReadableWorkspace) {
          firstReadableWorkspace = { workspace, timerResult };
        }

        if (timerResult.entry) {
          return response.status(200).json(
            successPayload({
              entry: timerResult.entry,
              region,
              userId,
              workspace,
            })
          );
        }
      }

      // The API key and region work, but there is no running timer right now.
      // Remember a readable workspace so future checks use the one-request path.
      if (firstReadableWorkspace) {
        return response.status(200).json(
          successPayload({
            entry: null,
            region,
            userId,
            workspace: firstReadableWorkspace.workspace,
          })
        );
      }
    }

    return response.status(403).json({
      error:
        "Clockify accepted neither the API key nor any workspace available to that key. Regenerate the API key in Clockify Preferences → Advanced while logged into the same email used by Make, replace CLOCKIFY_API_KEY in Vercel, and redeploy.",
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
