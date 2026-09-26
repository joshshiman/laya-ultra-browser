# The local ranker

An optional layer that ranks candidate elements for a stated goal, so you can write
`"the email address field"` instead of tracking refs.

**Everything on this page is a measurement or a published figure, not a projection.**
Where the model does not work, it says so.

## What it is

[Laya](https://laya.convaiinnovations.com/) is an Apache 2.0 encoder from Convai
Innovations: a bidirectional transformer, a single forward pass, no token decoding and
no generated output. It answers three question types — `choice`, `score` and `noul` —
by producing distributions over a fixed option set. Because it never generates tokens,
schema violations are structurally impossible.

Weights run locally through [`laya-mlx`](https://pypi.org/project/laya-mlx/), an
independent community port to Apple's MLX, so inference is on-device and free.

| Checkpoint | Encoder | Params | Context | Option head |
|---|---|---|---|---|
| `laya` | ModernBERT-large | 421M | 512 | 192 |
| `laya-multilingual` | mmBERT-base | 322M | 1024 | 256 |
| `laya-typed-decisions` | ModernBERT-large | 421M | 1024 | 256 |

The context figure is small and it is the binding constraint on the whole design. It
has to hold instructions, options and page state at once.

## Why rank instead of act

The interesting property is not judgement, it is **loop elimination**.

A conventional browser agent spends one large-model call *plus a screenshot* on every
single step. Rank a page's controls with this layer instead and it costs one forward
pass over a table of text, with no image anywhere:

| Operation | Measured on an M-series Mac, `choice` over 5 candidates |
|---|---|
| One ranking call | **97–182 ms** |
| Model load, warm | ~0.4 s |
| Model load, cold | ~19 s, plus a ~2GB download |

That is the win, and it is real. A remote-model step costs seconds and image tokens;
this costs a fraction of a second and nothing leaves the machine.

## What it does not do

It is not accurate out of the box. Measured on this project, asking which of five form
fields is the email address:

| Formulation | Result |
|---|---|
| `choice` over 5 fields | picked **"First name"** |
| `noul` per field | correct answer ranked **lowest** of five; total spread 0.10 |
| Both checkpoints | same outcome |

And on a harder question — find the opportunity in one region worth over 4M, from five
page sections:

| Formulation | Result |
|---|---|
| `choice` over 5 sections | picked the **smaller, wrong-region** deal |
| `noul` per section | correct answer ranked **dead last** (0.348, the minimum) |
| `score` per section | correct answer ranked 4th of 5 |

This matches the published numbers: the base checkpoint scores 0.362 on the
typed-decisions benchmark, and the authors' own guidance is to *"treat Laya as a fast
foundation model to specialize, not as an omniscient zero-shot oracle."*

**Confidence does not rescue it.** The authors' 51-language sweep found the English
checkpoint scoring 0.000 accuracy on Khmer at 0.952 mean confidence, and mean
confidence never dropping below 0.885 "regardless of whether its accuracy is 82% or
0%." Their conclusion, verbatim: *"Therefore, confidence gating cannot protect you."*

Separately, the runtime warns at load that this checkpoint ships calibration
temperatures outside the sane range and has to clamp them, adding that the affected
buckets should be treated as uncalibrated.

### So what is it for

- **Generating a shortlist fast**, which you then check. That is the supported use.
- **Cutting the number of round trips** on a page with many similar controls, where
  the deterministic matcher cannot separate them on name alone.
- **As a labelled-data generator** for fine-tuning, which is the path to making it
  genuinely useful. See below.

It is not a drop-in replacement for reading refs off a snapshot, and this project
does not pretend otherwise. When you have a ref, use the ref.

## How it is wired

```
goal + candidate table
   │
   ├─ lexical pre-filter        token overlap, role hints, penalise hidden/disabled
   │                            shortlist to <= LAYA_MAX_OPTIONS (default 12)
   │
   ├─ one `choice` question     a single forward pass over the shortlist
   │                            default; fastest
   │
   └─ per-candidate `noul`      one pass each; sidesteps the option ceiling
                                slower, better on large candidate sets
   │
   ▼
ranked refs + scores  ──►  the verified action layer acts, then reads back
```

The pre-filter exists because the option head has a fixed token budget. Past roughly
20 options accuracy collapses and the runtime raises rather than truncating, so the
full candidate list cannot go to the model. How many were pruned is reported on every
call, so nothing disappears silently.

`noul` is the stronger primitive in published benchmarks, and it is the only way past
the option ceiling. It costs one pass per candidate, so it trades latency for reach.

## Fine-tuning it

The supported path to real accuracy, and the tooling exists for it: the runtime ships
a `convert` subcommand, so the loop is train upstream, convert to MLX, serve locally.

1. **Generate labels.** Run the deterministic matcher over real pages and keep the
   cases where the answer is unambiguous. That gives you `(goal, candidate, correct)`
   triples without hand-labelling.
2. **Build an eval set first.** A few hundred held-out cases, so you can tell whether a
   change helped. Without it you are guessing.
3. **Fine-tune upstream** in PyTorch. Free hosted GPUs run the reference recipe in a
   few hours. MLX has no training support for this architecture, so this step is not
   done locally.
4. **Convert** with `laya-mlx convert`, point `LAYA_MODEL` at the result, and re-run
   the eval set.

The honest cost estimate: days, not hours, and most of it is steps 1 and 2. The
training run itself is the cheap part.

## Troubleshooting

**`browser_status` says Laya is unavailable.** It lists every interpreter it tried.
Run `npm run laya:check`, or set `LAYA_PYTHON` to an interpreter that can import the
runtime.

**Rankings look close to random.** Expected on the base checkpoint. See above.

**The first call is very slow.** It is loading the model, and the first ever run also
downloads about 2GB. `browser_status` with `warm: true` does this ahead of time.

**`LAYA_MODEL` changes do not take effect.** Restart the MCP server; the bridge is
spawned once and stays warm.

## Sources

- [Laya announcement and benchmarks](https://laya.convaiinnovations.com/)
- [convaiinnovations/laya-typed-decisions](https://huggingface.co/convaiinnovations/laya-typed-decisions)
- [laya-mlx on PyPI](https://pypi.org/project/laya-mlx/)
- [uv](https://docs.astral.sh/uv/)
