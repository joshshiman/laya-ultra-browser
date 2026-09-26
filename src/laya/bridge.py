"""Laya bridge: a long-lived subprocess that ranks browser candidates.

Why a subprocess and not a per-call invocation: importing the model costs ~0.4s warm
and ~19s on first load, and the first load also pulls roughly 2GB of weights. Paying
that per tool call would defeat the point of using a local model in the first place.

Protocol: newline-delimited JSON on stdin and stdout. One request object per line,
one response object per line, correlated by "id".

    -> {"id": 1, "op": "rank", "goal": "...", "candidates": [...], "mode": "choice"}
    <- {"id": 1, "ok": true, "ranked": [...], "pruned": 3, "elapsed_ms": 97}

stdout carries protocol frames only. Anything a library prints (tqdm download bars,
warnings) is redirected to stderr so it cannot corrupt the stream.

Laya's role here is deliberately narrow: it ranks a shortlist that a deterministic
pre-filter produced, and returns probabilities. It never touches the page and never
decides that an action succeeded. Those stay with the verified action layer.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import warnings

# Keep library chatter off stdout before anything else can write there.
_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr

warnings.filterwarnings("ignore")

# How each element kind is described to the model. Kept terse on purpose: the option
# head shares a fixed token budget, so every word spent here is a word not spent on
# the goal text.
_ROLE_HINT = {
    "textbox": "text field",
    "searchbox": "search field",
    "checkbox": "checkbox",
    "radio": "radio button",
    "combobox": "dropdown",
    "listbox": "list",
    "option": "option",
    "button": "button",
    "link": "link",
    "tab": "tab",
    "switch": "toggle",
    "slider": "slider",
    "spinbutton": "number field",
    "menuitem": "menu item",
}

_TOKEN_RE = re.compile(r"[a-z0-9]+")

# Reserved because the goal text is compared token-wise against them.
_STOPWORDS = frozenset(
    """a an the of to in on at for with and or is are be by from as that this it its
    field fields input inputs box button link text please click select choose pick
    find get set enter fill type value page element target control option
    """.split()
)


def _tokens(text: str) -> list[str]:
    return _TOKEN_RE.findall((text or "").lower())


def _content_tokens(text: str) -> set[str]:
    return {t for t in _tokens(text) if t not in _STOPWORDS and len(t) > 1}


def describe(candidate: dict) -> str:
    """One short line per candidate, for use as a choice option."""
    role = (candidate.get("role") or "").lower()
    name = (candidate.get("name") or "").strip()
    hint = _ROLE_HINT.get(role, role)
    ref = candidate.get("ref")
    bits = [f"ref {ref}"]
    if name:
        bits.append(f'"{name}"')
    if hint:
        bits.append(f"({hint})")
    value = (candidate.get("value") or "").strip()
    if value and value not in ("checkbox", "unchecked"):
        bits.append(f"currently {value[:40]!r}")
    return " ".join(bits)


def prerank(goal: str, candidates: list[dict]) -> list[dict]:
    """Deterministic lexical pre-filter.

    Laya's `choice` head shares a ~192 token budget across all options and its
    accuracy falls off a cliff past roughly 20, so the full candidate list cannot go
    to the model. This ranks on token overlap with the goal to produce a shortlist.
    It is a filter, not a decision: the model still chooses within the shortlist, and
    everything pruned is reported back so nothing disappears silently.
    """
    goal_tokens = _content_tokens(goal)
    scored = []
    for cand in candidates:
        name_tokens = _content_tokens(cand.get("name", ""))
        role = (cand.get("role") or "").lower()
        role_tokens = _content_tokens(_ROLE_HINT.get(role, role))
        overlap = len(goal_tokens & name_tokens) * 3 + len(goal_tokens & role_tokens)
        # A visible, enabled control is a more plausible target than a hidden one.
        if cand.get("disabled"):
            overlap -= 2
        if cand.get("visibility") and cand["visibility"] not in ("clear",):
            overlap -= 1
        scored.append((overlap, cand))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [cand for _, cand in scored]


class Bridge:
    def __init__(self) -> None:
        self._agent = None
        self._model_id = os.environ.get("LAYA_MODEL", "convaiinnovations/laya")
        self._checkpoint = os.environ.get("LAYA_CHECKPOINT", "") or None
        self._dtype = os.environ.get("LAYA_DTYPE", "float16")
        self.load_seconds: float | None = None

    def agent(self):
        if self._agent is None:
            import laya_mlx  # imported late so `ping` works without the weights

            t0 = time.time()
            self._agent = laya_mlx.load(
                self._model_id,
                subfolder=self._checkpoint,
                dtype=self._dtype,
                device="gpu",
            )
            self.load_seconds = time.time() - t0
            print(
                f"laya loaded {self._model_id}"
                f"{'/' + self._checkpoint if self._checkpoint else ''} "
                f"in {self.load_seconds:.2f}s",
                file=sys.stderr,
                flush=True,
            )
        return self._agent

    def info(self) -> dict:
        # Load first, then report. Reading the loaded flag before touching self.agent()
        # made a cold call answer "loaded: false" even though it had just loaded the
        # checkpoint and was returning its context length a line later.
        out: dict = {}
        try:
            agent = self.agent()
            out["loaded"] = True
            out["max_len"] = agent.cfg.get("max_len")
            out["head_max_len"] = agent.cfg.get("head_max_len")
        except Exception as exc:  # noqa: BLE001 - reported, not raised
            out["loaded"] = False
            out["load_error"] = f"{type(exc).__name__}: {exc}"

        out["model"] = self._model_id
        out["checkpoint"] = self._checkpoint
        out["dtype"] = self._dtype
        out["load_seconds"] = self.load_seconds
        # Scores from this checkpoint are not calibrated, and the dashboard says so.
        out["calibrated"] = False
        return out

    def rank(self, req: dict) -> dict:
        goal = req.get("goal") or ""
        candidates = req.get("candidates") or []
        mode = req.get("mode", "choice")
        max_options = int(req.get("max_options", 12))
        max_candidates = int(req.get("max_candidates", 60))

        if not goal.strip():
            raise ValueError("goal must be a non-empty string")
        if not candidates:
            return {"ranked": [], "pruned": 0, "mode": mode, "elapsed_ms": 0.0}

        pool = prerank(goal, candidates)
        agent = self.agent()
        mask = agent.tok.mask_token
        t0 = time.time()

        if mode == "noul":
            ranked, pruned = self._rank_noul(agent, goal, pool, mask, max_candidates)
        else:
            ranked, pruned = self._rank_choice(agent, goal, pool, mask, max_options)

        ranked.sort(key=lambda row: row["score"], reverse=True)
        return {
            "ranked": ranked,
            "pruned": pruned,
            "mode": mode,
            "elapsed_ms": round((time.time() - t0) * 1000, 1),
            "calibrated": False,
        }

    def _rank_choice(self, agent, goal, pool, mask, max_options):
        shortlist = pool[:max_options]
        pruned = len(pool) - len(shortlist)
        questions = {
            "pick": {
                "type": "choice",
                "instructions": (
                    f"Task the user wants done: {goal}\n"
                    f"Which element should be used? {mask}"
                ),
                "criteria": {f"r{c['ref']}": describe(c) for c in shortlist},
            }
        }
        out = agent.predict(goal, questions)
        answer = out["answers"]["pick"]
        probs = answer.get("probabilities") or {}
        by_ref = {f"r{c['ref']}": c for c in shortlist}
        ranked = []
        for key, prob in probs.items():
            cand = by_ref.get(key)
            if cand is None:
                continue
            ranked.append(
                {
                    "ref": cand["ref"],
                    "score": float(prob),
                    "role": cand.get("role"),
                    "name": cand.get("name"),
                }
            )
        if not ranked:
            # Model returned no probability map; fall back to the pre-rank order so
            # the caller still gets a usable ordering rather than an empty result.
            ranked = [
                {"ref": c["ref"], "score": 1.0 / (i + 1), "role": c.get("role"), "name": c.get("name")}
                for i, c in enumerate(shortlist)
            ]
        return ranked, pruned

    def _rank_noul(self, agent, goal, pool, mask, max_candidates):
        subset = pool[:max_candidates]
        pruned = len(pool) - len(subset)
        questions = {
            f"r{c['ref']}": {
                "type": "noul",
                "instructions": (
                    f"Element: {describe(c)}\n"
                    f"Task the user wants done: {goal}\n"
                    f"Is this the element to use? {mask}"
                ),
                "criteria": {
                    "false": "not the element to use",
                    "true": "is the element to use",
                },
            }
            for c in subset
        }
        out = agent.predict(goal, questions)
        answers = out["answers"]
        ranked = []
        for qid, res in answers.items():
            try:
                ref = int(qid[1:])
            except ValueError:
                continue
            ranked.append(
                {
                    "ref": ref,
                    "score": float(res.get("noul", 0.0)),
                    "role": None,
                    "name": None,
                }
            )
        # Fill names back in from the candidate list.
        by_ref = {c["ref"]: c for c in subset}
        for row in ranked:
            cand = by_ref.get(row["ref"])
            if cand:
                row["role"] = cand.get("role")
                row["name"] = cand.get("name")
        return ranked, pruned


def respond(payload: dict) -> None:
    payload["_bridge"] = "laya-ultra-browser/1"
    _REAL_STDOUT.write(json.dumps(payload, default=str) + "\n")
    _REAL_STDOUT.flush()


def main() -> int:
    bridge = Bridge()
    print("laya bridge ready", file=sys.stderr, flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            respond({"ok": False, "error": f"bad JSON: {exc}"})
            continue

        rid = req.get("id")
        op = req.get("op")
        try:
            if op == "ping":
                respond({"id": rid, "ok": True, "pong": True})
            elif op == "info":
                respond({"id": rid, "ok": True, "info": bridge.info()})
            elif op == "rank":
                respond({"id": rid, "ok": True, **bridge.rank(req)})
            elif op == "shutdown":
                respond({"id": rid, "ok": True, "bye": True})
                return 0
            else:
                respond({"id": rid, "ok": False, "error": f"unknown op {op!r}"})
        except Exception as exc:  # noqa: BLE001 - one bad request must not kill the bridge
            respond({"id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
