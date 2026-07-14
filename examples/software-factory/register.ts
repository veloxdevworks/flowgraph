import { registerFunction } from "@veloxdevworks/flowgraph-core";

type Feature = {
  title?: string;
  description?: string;
  track?: string;
  owner?: string;
  ticket?: string;
};

type Design = {
  summary?: string;
  revision?: number;
};

function asFeature(raw: unknown): Feature {
  return (raw ?? {}) as Feature;
}

function normalizeTrack(raw: string | undefined): "prototype" | "production" {
  const t = (raw ?? "").toLowerCase().trim();
  if (t === "prototype" || t === "mvp" || t === "spike") return "prototype";
  return "production";
}

registerFunction("intakeFeature", (input) => {
  const feature = asFeature((input as { feature?: unknown }).feature);
  const ticket = feature.ticket?.trim() || `SF-${Math.floor(Math.random() * 9000 + 1000)}`;
  const owner = feature.owner?.trim() || "product-owner";
  const title = feature.title?.trim() || "Untitled feature";
  const description = feature.description?.trim() || "";
  // Track is chosen by the choose-track HITL gate — do not auto-route here.
  const normalized: Feature = { ...feature, ticket, owner, title, description };
  const design: Design = {
    summary: `Design v1 for ${title}: ${description || "no description"}`,
    revision: 0,
  };
  return { feature: normalized, design };
});

registerFunction("applyTrackChoice", (input) => {
  const { choice, feature } = input as { choice?: string; feature?: Feature };
  const track = normalizeTrack(choice);
  const f = asFeature(feature);
  return {
    track,
    feature: { ...f, track },
  };
});

registerFunction("applyPromote", (input) => {
  const f = asFeature((input as { feature?: Feature }).feature);
  return {
    track: "production",
    feature: { ...f, track: "production", promotedFromPrototype: true },
  };
});

registerFunction("updateJira", (input) => {
  const { ticket = "SF-0000", status = "In Progress", title = "", environment } = input as {
    ticket?: string;
    status?: string;
    title?: string;
    environment?: string;
  };
  return {
    ticket,
    status,
    title,
    environment: environment ?? null,
    updatedAt: new Date().toISOString(),
    mock: true,
  };
});

registerFunction("chatOwner", (input) => {
  const {
    owner = "product-owner",
    kind = "info",
    title = "",
    ticket = "",
    environment,
  } = input as {
    owner?: string;
    kind?: string;
    title?: string;
    ticket?: string;
    environment?: string;
  };

  const messages: Record<string, string> = {
    "design-review": `Please review the design for ${ticket}: ${title}`,
    "release-review": `Quality gates passed for ${ticket}. Please approve production release.`,
    shipped: `${ticket} shipped to ${environment ?? "unknown"}: ${title}`,
  };

  return {
    channel: "dm",
    to: owner,
    kind,
    message: messages[kind] ?? `${kind}: ${ticket} ${title}`,
    at: new Date().toISOString(),
    mock: true,
  };
});

registerFunction("buildArtifact", (input) => {
  const { feature, track, design, plan } = input as {
    feature?: Feature;
    track?: string;
    design?: Design;
    plan?: { actions?: unknown[] };
  };
  const f = asFeature(feature);
  return {
    id: `artifact-${f.ticket ?? "unknown"}`,
    track: track ?? f.track,
    title: f.title,
    designRevision: design?.revision ?? 0,
    planActions: Array.isArray(plan?.actions) ? plan!.actions!.length : 0,
    builtAt: new Date().toISOString(),
  };
});

registerFunction("reviseDesign", (input) => {
  const { design, feature } = input as { design?: Design; feature?: Feature };
  const prev = design ?? {};
  const nextRev = Number(prev.revision ?? 0) + 1;
  const title = asFeature(feature).title ?? "feature";
  return {
    summary: `Design v${nextRev + 1} for ${title}: addressed review feedback`,
    revision: nextRev,
  };
});

registerFunction("kickoffReviews", (input) => {
  const f = asFeature((input as { feature?: Feature }).feature);
  return { started: true, ticket: f.ticket };
});

registerFunction("critiqueDesign", (input) => {
  const { feature, design } = input as { feature?: Feature; design?: Design };
  const f = asFeature(feature);
  return {
    kind: "design",
    severity: "medium",
    summary: `UX/IA review for ${f.title}`,
    findings: [
      "Clarify primary CTA hierarchy on the first screen",
      `Align with design revision ${design?.revision ?? 0}`,
    ],
    score: 7,
  };
});

registerFunction("critiquePerformance", (input) => {
  const f = asFeature((input as { feature?: Feature }).feature);
  return {
    kind: "performance",
    severity: "low",
    summary: `Perf budget check for ${f.title}`,
    findings: [
      "Keep p95 API latency under 200ms for the new path",
      "Defer non-critical client bundles",
    ],
    score: 8,
  };
});

registerFunction("critiqueSecurity", (input) => {
  const f = asFeature((input as { feature?: Feature }).feature);
  return {
    kind: "security",
    severity: "high",
    summary: `Threat model notes for ${f.title}`,
    findings: [
      "Validate authz on every new mutation endpoint",
      "Avoid logging PII in the new telemetry events",
    ],
    score: 6,
  };
});

registerFunction("aggregateReviews", (input) => {
  const { reviews = [], feature } = input as {
    reviews?: Array<{ kind?: string; severity?: string; findings?: string[]; score?: number }>;
    feature?: Feature;
  };
  const list = Array.isArray(reviews) ? reviews.filter((r) => r && r.kind) : [];
  const byKind = Object.fromEntries(list.map((r) => [r.kind, r]));
  const high = list.filter((r) => r.severity === "high").length;
  const themes = list.flatMap((r) => r.findings ?? []).slice(0, 8);
  const avgScore =
    list.length === 0
      ? 0
      : Math.round((list.reduce((s, r) => s + Number(r.score ?? 0), 0) / list.length) * 10) / 10;
  return {
    ticket: asFeature(feature).ticket,
    reviewCount: list.length,
    kinds: list.map((r) => r.kind),
    highSeverityCount: high,
    avgScore,
    themes,
    byKind,
  };
});

registerFunction("followUpPlan", (input) => {
  const { synthesis, feature } = input as {
    synthesis?: {
      themes?: string[];
      highSeverityCount?: number;
      avgScore?: number;
      kinds?: string[];
    };
    feature?: Feature;
  };
  const f = asFeature(feature);
  const themes = synthesis?.themes ?? [];
  const actions = themes.slice(0, 5).map((t, i) => ({
    priority: i + 1,
    action: t,
  }));
  if ((synthesis?.highSeverityCount ?? 0) > 0) {
    actions.unshift({
      priority: 0,
      action: "Resolve high-severity security findings before GA",
    });
  }
  return {
    ticket: f.ticket,
    title: `Follow-up plan for ${f.title}`,
    basedOn: synthesis?.kinds ?? [],
    avgScore: synthesis?.avgScore,
    actions,
  };
});

registerFunction("runI18n", (input) => {
  const { artifact } = input as { artifact?: { id?: string } };
  return {
    i18n: {
      passed: true,
      locales: ["en", "es", "ja"],
      missingKeys: 0,
      artifactId: artifact?.id,
    },
  };
});

registerFunction("runA11y", (input) => {
  const { artifact } = input as { artifact?: { id?: string } };
  return {
    a11y: {
      passed: true,
      wcag: "AA",
      violations: 0,
      artifactId: artifact?.id,
    },
  };
});

registerFunction("runUnitTests", (input) => {
  const { artifact } = input as { artifact?: { id?: string } };
  return {
    unit: {
      passed: true,
      tests: 42,
      failed: 0,
      artifactId: artifact?.id,
    },
  };
});

registerFunction("runE2e", (input) => {
  const { artifact, fixAttempt = 0 } = input as {
    artifact?: { id?: string };
    fixAttempt?: number;
  };
  return {
    e2e: {
      passed: true,
      suites: 8,
      fixAttempt: Number(fixAttempt),
      artifactId: artifact?.id,
    },
  };
});

registerFunction("runO11y", (input) => {
  const { artifact } = input as { artifact?: { id?: string } };
  return {
    o11y: {
      passed: true,
      dashboards: ["latency", "errors", "saturation"],
      alertsWired: true,
      artifactId: artifact?.id,
    },
  };
});

registerFunction("fixAndRetest", (input) => {
  const { artifact, fixAttempt = 0 } = input as {
    artifact?: Record<string, unknown>;
    fixAttempt?: number;
  };
  const next = Number(fixAttempt) + 1;
  return {
    artifact: {
      ...(artifact ?? {}),
      patched: true,
      fixAttempt: next,
    },
    fixAttempt: next,
  };
});

registerFunction("deploy", (input) => {
  const { artifact, environment = "staging", track } = input as {
    artifact?: { id?: string; title?: string };
    environment?: string;
    track?: string;
  };
  return {
    environment,
    track,
    artifactId: artifact?.id,
    title: artifact?.title,
    url: `https://${environment}.example.internal/${artifact?.id ?? "app"}`,
    deployedAt: new Date().toISOString(),
  };
});

registerFunction("recordOutcome", (input) => {
  const { feature, track, deploy, jira, checks, synthesis, plan } = input as {
    feature?: Feature;
    track?: string;
    deploy?: { environment?: string; url?: string };
    jira?: { status?: string; ticket?: string };
    checks?: Record<string, unknown>;
    synthesis?: { reviewCount?: number; avgScore?: number };
    plan?: { actions?: unknown[] };
  };
  const f = asFeature(feature);
  return {
    status: "completed",
    track,
    ticket: f.ticket,
    title: f.title,
    environment: deploy?.environment,
    url: deploy?.url,
    jiraStatus: jira?.status,
    checks: checks ?? {},
    reviewCount: synthesis?.reviewCount ?? 0,
    planActions: Array.isArray(plan?.actions) ? plan!.actions!.length : 0,
  };
});

export {};
