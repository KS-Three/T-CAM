/**
 * buck-match.mjs — ask a vision model which named buck a photograph shows.
 *
 * KENT'S CALL, 2026-09-09, and it reverses a decision recorded twice in
 * design.md §4. The reasoning for the reversal is in that file; the reasoning
 * for the SHAPE of this module is here, because it is what keeps the reversal
 * safe.
 *
 * The old objection was never that a model cannot see antlers. It was that a
 * wrong identity **silently** corrupts every movement pattern built on it: the
 * per-buck statistics in individuals.mjs, the daily budgets, everything
 * downstream of "this was Split G2". A 2026 livestock paper measured identity
 * switches around one per 500 frames per animal even with video and motion
 * continuity, which is a far easier problem than night infrared stills from
 * arbitrary angles.
 *
 * What changed is the word SILENTLY. Kent asked for a confidence, and for
 * anything doubtful to come to him. That turns the failure mode from a wrong
 * fact into a wrong suggestion, and this repo already has a place for wrong
 * suggestions: the vendor's own AI tag, stored as an unconfirmed claim and
 * shown as "the camera thinks" until a person agrees (design.md §3).
 *
 * So the rule this file exists to enforce:
 *
 *   NOTHING HERE WRITES ANYTHING. It returns a proposal. Storing it is the
 *   caller's job, and the only shape it may be stored in is an UNCONFIRMED
 *   detection with source 'assist' (migration 19), which is invisible to the
 *   stand ranking and to individuals.mjs until Kent confirms it.
 *
 * There is deliberately no auto-accept threshold. A high confidence is not a
 * licence to write, because a confidently wrong match is the exact case that
 * corrupts the record — the one the original decision was about. Confidence
 * orders the buttons and decides how loudly to ask; it never decides to skip
 * asking.
 *
 * PHOTOS LEAVE THE MACHINE. That reverses design.md §1 and §6, which kept
 * everything local. It is opt-in, it is off without a key, and the caller has
 * to pass the images in deliberately — there is no ambient "sync everything up"
 * path. Only the animal's photograph goes; no coordinates, no camera name, no
 * property.
 *
 * ZERO DEPENDENCIES SURVIVES. This is raw HTTP over the global fetch every
 * other service in this repo already uses (SpyPoint, the tile servers, the
 * terrain and Sentinel endpoints). The official SDK would be the normal choice
 * in any other project; here it would end the no-install-step guarantee and
 * the double-click launcher with it, which is not a trade to make for one
 * POST. The wire format below is from the published Vision and Messages
 * documentation, not from memory.
 */

// Read per call, not once at import. The sync gets away with a module-level
// constant because it runs as a subprocess; a module imported in-process would
// freeze whatever the environment held at load, which is both untestable and a
// trap for anything that configures itself after startup.
export const apiBase = () => process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com';

/** The model is a knob, not a fact. See README for what it costs. */
export const DEFAULT_MODEL = process.env.TRAILCAM_MATCH_MODEL || 'claude-opus-5';

/** What the API accepts. A trail camera sends JPEG; the rest are here so a
 *  future provider's PNG is not a silent failure. */
export const IMAGE_TYPES = Object.freeze({
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
});

/** 10 MB base64 per image, 32 MB per request, per the published limits. A
 *  SpyPoint "large" frame is about 50 KB, so this is a guard, not a squeeze. */
export const MAX_IMAGE_BYTES = 7 * 1024 * 1024;

/**
 * The one tool the model may answer with.
 *
 * A tool rather than free text because the answer has to be MACHINE-READ: a
 * confidence parsed out of prose is a confidence that will one day be parsed
 * wrong, and a wrong confidence defeats the gate this whole feature rests on.
 *
 * `buck` is a NAME rather than an id because a name is what the model can see
 * a reason for; the caller maps it back, and a name that maps to nothing is
 * discarded rather than guessed at.
 */
export const MATCH_TOOL = Object.freeze({
  name: 'report_match',
  description: 'Report which of the named bucks, if any, the new photograph shows.',
  input_schema: {
    type: 'object',
    properties: {
      buck: {
        type: 'string',
        description: 'The name of the matching buck exactly as given, or "none" '
          + 'if none of them match, or if the photograph does not show enough to tell.',
      },
      confidence: {
        type: 'integer', minimum: 0, maximum: 100,
        description: 'How sure you are, 0 to 100. Be honest about a bad frame: '
          + 'a low number is useful and a wrong high number is not.',
      },
      why: {
        type: 'string',
        description: 'The specific visible features that decided it — points, '
          + 'beam shape, brow tines, a scar, body markings. Say what you could '
          + 'NOT see as well.',
      },
    },
    required: ['buck', 'confidence', 'why'],
  },
});

const SYSTEM = [
  'You are helping a hunter tell his own trail-camera photographs apart.',
  'He has named individual bucks and given you reference photographs of each.',
  'Decide whether the new photograph shows one of those same animals.',
  '',
  'These are difficult images: infrared at night, motion blur, odd angles,',
  'and antlers change through a season. Being unsure is the normal outcome and',
  'is genuinely useful to him. A confident wrong answer is worse than no',
  'answer, because it becomes a data point in his records.',
  '',
  'Answer only by calling report_match.',
].join('\n');

const isStr = v => typeof v === 'string' && v.trim() !== '';

/** One image block, in the documented shape, preceded by its own label. */
function imageBlocks(label, image) {
  return [
    { type: 'text', text: label },
    { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
  ];
}

/**
 * Build the request body. Separated from the sending so a test can assert the
 * shape without a server, and so the shape is readable in one piece.
 *
 * Images come BEFORE the question, which the vision guide says works best, and
 * each carries a text label so the prompt can refer to it.
 */
export function buildRequest({ candidate, references, model = DEFAULT_MODEL }) {
  const content = [];
  for (const ref of references) {
    ref.images.forEach((img, i) => {
      content.push(...imageBlocks(
        `Reference — "${ref.name}"${ref.images.length > 1 ? ` (${i + 1} of ${ref.images.length})` : ''}:`,
        img));
    });
  }
  content.push(...imageBlocks('The new photograph:', candidate));
  content.push({
    type: 'text',
    text: `The named bucks are: ${references.map(r => `"${r.name}"`).join(', ')}.\n\n`
      + 'Does the new photograph show one of them? Call report_match with the '
      + 'name, your confidence, and what you actually looked at. Use "none" if '
      + 'it is a different animal, or if the frame does not show enough to say.',
  });

  return {
    model,
    max_tokens: 2048,
    system: SYSTEM,
    tools: [MATCH_TOOL],
    tool_choice: { type: 'tool', name: MATCH_TOOL.name },
    messages: [{ role: 'user', content }],
  };
}

/**
 * Ask about one photograph.
 *
 * Returns a PROPOSAL or null. Never throws for an ordinary failure — a network
 * hiccup, a refusal, a malformed answer — because the caller's correct
 * response to all of those is identical and boring: no suggestion, tag it by
 * hand. Only a programming error (no key, no references) throws, because those
 * are worth stopping for.
 */
export async function matchBuck({ candidate, references, model = DEFAULT_MODEL,
  apiKey = process.env.ANTHROPIC_API_KEY, baseUrl = apiBase(), fetchImpl = fetch } = {}) {
  if (!isStr(apiKey)) {
    throw new Error('ANTHROPIC_API_KEY is not set — buck matching is off until it is');
  }
  if (!candidate?.base64 || !isStr(candidate.mediaType)) {
    throw new Error('a candidate photograph with base64 and mediaType is required');
  }
  if (!Array.isArray(references) || references.length === 0) {
    throw new Error('name at least one buck, with a reference photograph, first');
  }

  let res;
  try {
    res = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(buildRequest({ candidate, references, model })),
    });
  } catch (err) {
    return refused(`could not reach the service (${err.message})`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return refused(`HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`);
  }

  let body;
  try { body = await res.json(); } catch { return refused('the answer was not JSON'); }

  // A refusal arrives as HTTP 200 with stop_reason "refusal", so the status
  // alone does not tell you the request was answered.
  if (body?.stop_reason === 'refusal') {
    return refused(`declined${body.stop_details?.category ? ` (${body.stop_details.category})` : ''}`);
  }

  const call = (body?.content ?? []).find(b => b?.type === 'tool_use' && b.name === MATCH_TOOL.name);
  if (!call) return refused('no answer in the documented shape');

  return readProposal(call.input, references, body.usage ?? null, model);
}

/** A non-answer, with the reason kept. Callers show it rather than a blank. */
const refused = why => ({ buckId: null, name: null, confidence: null, why, answered: false });

/**
 * Turn the model's answer into a proposal, refusing anything unusable.
 *
 * A name that matches no buck is dropped rather than fuzzy-matched: a
 * near-miss on a name is exactly how one buck's sightings end up filed under
 * another, which is the corruption this whole design is built to avoid.
 */
export function readProposal(input, references, usage = null, model = DEFAULT_MODEL) {
  const name = isStr(input?.buck) ? input.buck.trim() : null;
  const why = isStr(input?.why) ? input.why.trim() : null;
  // Rejected BEFORE conversion, not after. Number(null) and Number('') are both
  // 0, so a bare Number() here turns "it said nothing" into "certainly not" —
  // and a fabricated zero confidence is exactly the kind of invented value this
  // whole feature is built to avoid. The repo has been bitten by this three
  // times already; writing the warning down is not the same as obeying it, so
  // this reads the type first.
  const given = input?.confidence;
  const raw = typeof given === 'number' ? given : (isStr(given) ? Number(given) : NaN);
  const confidence = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : null;

  if (!name || confidence === null) return refused('the answer was incomplete');
  if (name.toLowerCase() === 'none') {
    return { buckId: null, name: null, confidence, why, answered: true, model, usage };
  }

  const hit = references.find(r => r.name.toLowerCase() === name.toLowerCase());
  if (!hit) return refused(`named "${name}", which is not one of the bucks offered`);

  return { buckId: hit.buckId, name: hit.name, confidence, why, answered: true, model, usage };
}

/**
 * How the proposal should be described to a person.
 *
 * Deliberately never "Split G2" on its own. The camera's species claims read
 * "the camera thinks"; this reads the same way, because the sentence a person
 * skims is the last place the distinction between a guess and a fact can be
 * lost.
 */
export function proposalLine(p) {
  if (!p || !p.answered) return `No suggestion — ${p?.why ?? 'nothing came back'}.`;
  if (!p.buckId) return `Thinks this is none of your named bucks (${p.confidence}% sure).`;
  return `Thinks this is ${p.name} — ${p.confidence}% sure. Your call.`;
}

/**
 * Visual tokens an image costs: one per 28x28 patch, per the vision guide.
 *
 * Here so the cost of a season can be estimated before it is spent rather than
 * discovered on a bill. The model downsizes above its own limit, so this is an
 * upper bound for anything larger.
 */
export const visualTokens = (width, height) =>
  Math.ceil(width / 28) * Math.ceil(height / 28);
