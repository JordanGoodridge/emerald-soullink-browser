// DOM-free model for a future SoulLink tracker UI.

function sectionLabel(section, labels) {
  return section.name ?? labels?.[section.id] ?? `Area ${section.id}`;
}

function allAreaMembers(area, run) {
  return (run.members ?? []).map((member) => {
    const claim = area?.claims?.[member.playerId];
    return {
      ...(claim ?? { playerId: member.playerId, status: 'waiting', species: null, pid: null }),
      name: member.name ?? 'Player',
      active: member.active !== false,
    };
  });
}

export function buildRunTracker({ run = null, presence = null, regionMap = null, sectionLabels = null } = {}) {
  const sectionsInput = regionMap?.sections ?? [];
  if (!run) {
    return {
      status: 'unavailable', players: [], sections: [], links: [], pending: [],
      graveyard: [], events: [], summary: { visited: 0, linked: 0, pending: 0, dead: 0, void: 0, total: sectionsInput.length },
    };
  }

  const areasBySection = new Map();
  for (const area of Object.values(run.areas ?? {})) {
    if (Object.values(area.claims ?? {}).some((claim) => claim.isGift)) continue;
    const sectionId = area.sectionId;
    if (sectionId === null || sectionId === undefined) continue;
    if (!areasBySection.has(sectionId)) areasBySection.set(sectionId, []);
    areasBySection.get(sectionId).push(area);
  }

  const sections = sectionsInput.map((section) => {
    const areas = areasBySection.get(section.id) ?? [];
    const statuses = areas.map((area) => area.status);
    const status = statuses.includes('void') ? 'void'
      : statuses.includes('dead') ? 'dead'
        : statuses.includes('pending') ? 'pending'
          : statuses.includes('linked') ? 'linked'
            : areas.some((area) => Object.values(area.claims ?? {}).some((claim) => claim.status === 'caught')) ? 'claimed'
              : areas.some((area) => ['available', 'open'].includes(area.status) || (area.visits?.length ?? 0) > 0) ? 'available' : 'unvisited';
    return {
      ...section,
      label: sectionLabel(section, sectionLabels),
      status,
      visited: areas.some((area) => (area.visits?.length ?? 0) > 0)
        || areas.some((area) => Object.keys(area.claims ?? {}).length > 0),
      areaKeys: areas.map((area) => area.areaKey),
      areas: areas.map((area) => ({
        areaKey: area.areaKey,
        label: area.label ?? area.areaKey,
        status: area.status,
        linkId: area.linkId ?? null,
        members: allAreaMembers(area, run),
        skips: [...(area.skips ?? [])],
      })),
    };
  });

  const links = Object.values(run.links ?? {}).map((link) => ({
    ...link,
    area: run.areas?.[link.areaKey]?.label ?? link.areaKey,
    sectionId: run.areas?.[link.areaKey]?.sectionId ?? null,
    members: (link.members ?? []).map((member) => ({
      ...member,
      name: run.members.find((candidate) => candidate.playerId === member.playerId)?.name ?? 'Player',
    })),
  }));
  const pending = Object.values(run.areas ?? {})
    .filter((area) => area.status === 'pending' || area.status === 'open' || area.status === 'available')
    .map((area) => ({
      areaKey: area.areaKey,
      area: area.label ?? area.areaKey,
      sectionId: area.sectionId ?? null,
      members: allAreaMembers(area, run),
    }));
  const players = (run.members ?? []).map((member) => {
    const presenceMember = presence?.members?.find((candidate) => candidate.playerId === member.playerId);
    const world = presenceMember?.latest?.state?.world ?? null;
    return {
      playerId: member.playerId,
      name: member.name,
      active: member.active !== false,
      ready: member.ready === true,
      currentWorld: world,
      currentSectionId: world?.sectionId ?? null,
    };
  });
  const statusCount = (status) => sections.filter((section) => section.status === status).length;
  const gifts = Object.values(run.areas ?? {})
    .filter((area) => Object.values(area.claims ?? {}).some((claim) => claim.isGift))
    .map((area) => ({
      areaKey: area.areaKey,
      label: area.label ?? area.areaKey,
      status: area.status,
      members: allAreaMembers(area, run),
    }));

  return {
    status: run.status,
    runId: run.runId,
    players,
    sections,
    links,
    pending,
    gifts,
    graveyard: [...(run.deaths ?? [])],
    events: [...(run.events ?? [])],
    summary: {
      visited: sections.filter((section) => section.visited).length,
      linked: statusCount('linked'),
      pending: statusCount('pending'),
      dead: statusCount('dead'),
      void: statusCount('void'),
      total: sections.length,
    },
  };
}
