"""
Train LinearUrgencyModel on synthetic, expert-labeled scenario
data and save the learned weights to app/urgency_weights.json.

There is no logged history of real incident->resource->outcome
data for this project yet (see app/training/scenarios.py and
app/training/ground_truth.py for what the training data actually
is and isn't). This script exists so the moment real outcome
data does exist, it's a drop-in replacement for
generate_dataset() + expert_urgency_label() below -- the training
loop, evaluation, and weight-loading in resource_allocator.py
don't need to change.

Usage:
    python scripts/train_urgency_model.py
"""

from __future__ import annotations

import json
import os
import random
import sys

sys.path.insert(
    0,
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
)

from app.resource_allocator import (  # noqa: E402
    DEFAULT_URGENCY_WEIGHTS,
    FEATURE_ORDER,
    LinearUrgencyModel,
    incident_to_cluster,
)
from app.training.ground_truth import expert_urgency_label  # noqa: E402
from app.training.scenarios import generate_dataset  # noqa: E402


WEIGHTS_OUTPUT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "app",
    "urgency_weights.json",
)

TRAIN_FRACTION = 0.8
# fit() uses the exact derivative of the normalized score
# (100 * w.f / sum(w)), whose gradient carries a factor of ~100 --
# hence the small step size. Anything above ~2.5e-4 diverges on this
# dataset; fit() keeps the best-loss weights so a bad value can never
# be saved, but this is the value that actually converges.
LEARNING_RATE = 0.0001
EPOCHS = 800
LABEL_SEED = 7
DATASET_SEED = 42
PER_ARCHETYPE = 25


def _mean_squared_error(
    model: LinearUrgencyModel,
    examples: list,
) -> float:

    errors = [
        (model.score(cluster) - target) ** 2
        for cluster, target in examples
    ]

    return sum(errors) / len(errors)


def _mean_absolute_error(
    model: LinearUrgencyModel,
    examples: list,
) -> float:

    errors = [
        abs(model.score(cluster) - target)
        for cluster, target in examples
    ]

    return sum(errors) / len(errors)


def main() -> None:

    label_rng = random.Random(LABEL_SEED)
    split_rng = random.Random(LABEL_SEED)

    # --------------------------------------------------------
    # 1. GENERATE SCENARIOS
    # --------------------------------------------------------

    incidents = generate_dataset(
        per_archetype=PER_ARCHETYPE,
        seed=DATASET_SEED,
    )

    # --------------------------------------------------------
    # 2. BUILD FEATURES + GROUND-TRUTH LABELS
    # --------------------------------------------------------

    examples = []

    for index, incident in enumerate(incidents):
        cluster = incident_to_cluster([incident], f"TRAIN-{index:04d}")
        target = expert_urgency_label(cluster, label_rng)
        examples.append((cluster, target))

    split_rng.shuffle(examples)

    split_index = int(len(examples) * TRAIN_FRACTION)
    train_examples = examples[:split_index]
    test_examples = examples[split_index:]

    print(f"Total examples:    {len(examples)}")
    print(f"Training examples: {len(train_examples)}")
    print(f"Test examples:     {len(test_examples)}")

    # --------------------------------------------------------
    # 3. BASELINE (HAND-TUNED WEIGHTS, UNTRAINED)
    # --------------------------------------------------------

    baseline_model = LinearUrgencyModel(DEFAULT_URGENCY_WEIGHTS)

    baseline_train_mse = _mean_squared_error(baseline_model, train_examples)
    baseline_test_mse = _mean_squared_error(baseline_model, test_examples)
    baseline_test_mae = _mean_absolute_error(baseline_model, test_examples)

    # --------------------------------------------------------
    # 4. TRAIN VIA GRADIENT DESCENT
    # --------------------------------------------------------

    trained_model = LinearUrgencyModel(DEFAULT_URGENCY_WEIGHTS)
    trained_model.fit(
        train_examples,
        learning_rate=LEARNING_RATE,
        epochs=EPOCHS,
    )

    trained_train_mse = _mean_squared_error(trained_model, train_examples)
    trained_test_mse = _mean_squared_error(trained_model, test_examples)
    trained_test_mae = _mean_absolute_error(trained_model, test_examples)

    # --------------------------------------------------------
    # 5. REPORT
    # --------------------------------------------------------

    print("\n=== Error (0-100 urgency scale) ===")
    print(f"{'':20s}{'train MSE':>12s}{'test MSE':>12s}{'test MAE':>12s}")
    print(
        f"{'before training':20s}"
        f"{baseline_train_mse:12.2f}"
        f"{baseline_test_mse:12.2f}"
        f"{baseline_test_mae:12.2f}"
    )
    print(
        f"{'after training':20s}"
        f"{trained_train_mse:12.2f}"
        f"{trained_test_mse:12.2f}"
        f"{trained_test_mae:12.2f}"
    )

    print("\n=== Weights ===")
    print(f"{'feature':25s}{'default':>10s}{'trained':>10s}")
    for key in FEATURE_ORDER:
        print(
            f"{key:25s}"
            f"{DEFAULT_URGENCY_WEIGHTS[key]:10.3f}"
            f"{trained_model.weights[key]:10.3f}"
        )

    # --------------------------------------------------------
    # 6. SAVE
    # --------------------------------------------------------

    with open(WEIGHTS_OUTPUT_PATH, "w", encoding="utf-8") as handle:
        json.dump(trained_model.weights, handle, indent=2)
        handle.write("\n")

    print(f"\nSaved trained weights to {WEIGHTS_OUTPUT_PATH}")
    print(
        "app/resource_allocator.py loads this file automatically "
        "on next import/restart."
    )


if __name__ == "__main__":
    main()
