#!/usr/bin/env python3
"""Small stdlib-only Showdown Arena agent runner."""

import json
import random
import sys


def send(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def choose(observation, policy, rng):
    actions = observation.get("legalActions") or []
    if not actions:
        raise ValueError("observation has no legal actions")
    if policy == "heuristic":
        moves = [action for action in actions if action.get("type") == "move"]
        # Tera only when it is the first available move; this keeps the policy predictable.
        return moves[0] if moves else actions[0]
    return rng.choice(actions)


def main(policy):
    rng = random.Random()
    initialized = False
    for raw in sys.stdin:
        if len(raw) > 64 * 1024:
            raise ValueError("protocol line too long")
        message = json.loads(raw)
        if not initialized:
            if message.get("type") != "init" or message.get("protocolVersion") != 1:
                raise ValueError("expected init")
            rng.seed(message.get("policySeed"))
            initialized = True
            send({"type": "ready", "protocolVersion": 1})
            continue
        if message.get("type") == "end":
            return
        if message.get("protocolVersion") != 1 or message.get("phase") != "battle":
            raise ValueError("expected observation")
        send({"requestId": message["requestId"], "action": choose(message, policy, rng)})
    if not initialized:
        raise ValueError("missing init")


if __name__ == "__main__":
    try:
        main(sys.argv[1] if len(sys.argv) > 1 else "random")
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
