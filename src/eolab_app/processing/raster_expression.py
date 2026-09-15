"""Bounded, typed raster expression grammar and streaming scalar reductions."""

from dataclasses import dataclass
import math
import re
from typing import Any

import numpy as np

from eolab_app.processing.models import ProcessingError

FUNCTIONS = frozenset({"count", "sum", "mean", "min", "max", "areaha"})
MAX_NODES = 256
MAX_DEPTH = 20
TOKEN = re.compile(
    r"\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z][A-Za-z0-9_]*)|(>=|<=|==|!=|&&|\|\||[+*/!<>()=,\-]))"
)
PRECEDENCE = {
    "||": 1,
    "&&": 2,
    "==": 3,
    "!=": 3,
    ">": 4,
    "<": 4,
    ">=": 4,
    "<=": 4,
    "+": 5,
    "-": 5,
    "*": 6,
    "/": 6,
}


@dataclass(frozen=True)
class Node:
    """Immutable typed syntax; no executable Python objects or source paths."""

    op: str
    args: tuple["Node", ...] = ()
    value: float | None = None
    boolean: bool = False
    scalar: bool = False
    depth: int = 1


class Parser:
    """Parse only the documented calculation grammar with bounded recursion."""

    def __init__(self, text: str, alias: str) -> None:
        """Tokenize bounded text against one bound source name.

        Args:
            text: User expression, limited before parsing.
            alias: Validated catalog source alias.
        """
        if len(text.encode("utf-8")) > 4096:
            raise ProcessingError(
                "invalid_expression", "Expressions must fit within 4 KiB."
            )
        self.tokens: list[tuple[str, int]] = []
        self.index = self.nodes = self.nesting = 0
        self.alias = alias
        position = 0
        while position < len(text):
            if not text[position:].strip():
                break
            match = TOKEN.match(text, position)
            if match is None:
                raise ProcessingError(
                    "invalid_expression",
                    f"Unexpected character at column {position + 1}.",
                )
            self.tokens.append(
                (
                    next(value for value in match.groups() if value is not None),
                    match.start() + 1,
                )
            )
            position = match.end()
        self.tokens.append(("", len(text) + 1))

    def error(self, message: str) -> ProcessingError:
        """Return a location-bearing grammar error.

        Args:
            message: Public description of the invalid syntax/type.

        Returns:
            Sanitized validation error for the current token.
        """
        return ProcessingError(
            "invalid_expression", f"{message} At column {self.tokens[self.index][1]}."
        )

    def take(self, expected: str | None = None) -> str:
        """Consume one token, optionally requiring an exact spelling.

        Args:
            expected: Required token or None.

        Returns:
            Consumed token text.
        """
        token = self.tokens[self.index][0]
        if expected is not None and token != expected:
            raise self.error(f"Expected '{expected}'")
        if not token:
            raise self.error("Incomplete expression")
        self.index += 1
        return token

    def node(self, op: str, args: tuple[Node, ...] = (), **values: Any) -> Node:
        """Create one node while bounding tree size and evaluation depth.

        Args:
            op: Allowlisted operation.
            args: Already-checked child nodes.
            values: Literal value and inferred type fields.

        Returns:
            Immutable typed node.
        """
        self.nodes += 1
        depth = 1 + max((arg.depth for arg in args), default=0)
        if self.nodes > MAX_NODES or depth > MAX_DEPTH:
            raise self.error("Expression is too complex")
        return Node(op, args, depth=depth, **values)

    def expression(self, minimum: int = 0) -> Node:
        """Parse a precedence-delimited expression.

        Args:
            minimum: Minimum binary-operator precedence admitted here.

        Returns:
            Checked scalar or pixel expression.
        """
        self.nesting += 1
        if self.nesting > MAX_DEPTH:
            raise self.error("Expression is nested too deeply")
        token = self.take()
        if token in {"-", "+", "!"}:
            child = self.expression(7)
            if (token == "!") != child.boolean:
                raise self.error(
                    "Logical NOT requires a condition; signs require numbers"
                )
            left = self.node(
                "unary" + token, (child,), boolean=child.boolean, scalar=child.scalar
            )
        elif token == "(":
            left = self.expression()
            self.take(")")
        elif token == self.alias:
            left = self.node("source")
        elif token in FUNCTIONS:
            self.take("(")
            argument = self.expression()
            args = (argument,)
            if self.tokens[self.index][0] == ",":
                self.take(",")
                self.take("where")
                self.take("=")
                condition = self.expression()
                if not condition.boolean or any(
                    node.op in FUNCTIONS for node in walk(condition)
                ):
                    raise self.error("where requires a pixel condition")
                args += (condition,)
            self.take(")")
            if any(node.op in FUNCTIONS for arg in args for node in walk(arg)):
                raise self.error("Aggregates cannot be nested")
            if token == "areaha" and (not argument.boolean or len(args) != 1):
                raise self.error(
                    "areaha requires one condition, for example areaha(a == 4)"
                )
            if token not in {"count", "sum", "areaha"} and argument.boolean:
                raise self.error(f"{token} requires numeric values")
            left = self.node(token, args, scalar=True)
        else:
            try:
                value = float(token)
            except ValueError as error:
                raise self.error(f"Unknown source or function '{token}'") from error
            if not math.isfinite(value):
                raise self.error("Use finite numeric constants")
            left = self.node("number", value=value, scalar=True)
        while PRECEDENCE.get(self.tokens[self.index][0], -1) >= minimum:
            op = self.take()
            right = self.expression(PRECEDENCE[op] + 1)
            boolean = op in {"&&", "||", "==", "!=", ">", "<", ">=", "<="}
            if op in {"&&", "||"}:
                if not left.boolean or not right.boolean:
                    raise self.error("Logical operators require conditions")
            elif left.boolean or right.boolean:
                raise self.error("Arithmetic and comparisons require numeric values")
            if op == "/" and right.op == "number" and right.value == 0:
                raise self.error("Cannot divide by zero")
            left = self.node(
                op, (left, right), boolean=boolean, scalar=left.scalar and right.scalar
            )
        self.nesting -= 1
        return left


def walk(node: Node):
    """Yield syntax nodes in bounded tree order.

    Args:
        node: Validated expression root.

    Yields:
        Each node, including repeated syntactic occurrences.
    """
    yield node
    for child in node.args:
        yield from walk(child)


def compile_expression(text: str, alias: str) -> Node:
    """Validate source bindings and require one scalar numerical result.

    Args:
        text: Bounded expression text.
        alias: The single source bound by the operation.

    Returns:
        Typed, bounded expression tree.
    """
    parser = Parser(text, alias)
    root = parser.expression()
    if parser.tokens[parser.index][0]:
        raise parser.error("Unexpected trailing input")
    nodes = tuple(walk(root))
    if (
        not root.scalar
        or root.boolean
        or not any(node.op in FUNCTIONS for node in nodes)
    ):
        raise parser.error("A calculation must produce a scalar aggregate result")
    if not any(node.op == "source" for node in nodes):
        raise parser.error("A calculation must reference its raster")
    return root


def apply_operator(node: Node, values: list[Any]) -> Any:
    """Evaluate an allowlisted arithmetic/logical operator on values.

    Args:
        node: Validated operator node.
        values: Scalar or equally shaped array operands.

    Returns:
        Operator result; caller applies validity and finite-value checks.
    """
    op = node.op
    if op == "unary-":
        return -values[0]
    if op == "unary+":
        return values[0]
    if op == "unary!":
        return np.logical_not(values[0])
    a, b = values
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        return a / b
    if op == ">":
        return a > b
    if op == "<":
        return a < b
    if op == ">=":
        return a >= b
    if op == "<=":
        return a <= b
    if op == "==":
        return a == b
    if op == "!=":
        return a != b
    if op == "&&":
        return np.logical_and(a, b)
    if op == "||":
        return np.logical_or(a, b)
    raise ValueError("Unrecognized validated operator")


class Reduction:
    """Bounded running accumulator for one aggregate node."""

    def __init__(self, node: Node) -> None:
        """Initialize an aggregate.

        Args:
            node: Validated aggregate node.
        """
        self.node = node
        self.valid = self.matched = self.invalid = 0
        self.total = self.compensation = self.mean = 0.0
        self.minimum = math.inf
        self.maximum = -math.inf
        self.overflow = False

    def update(
        self, data: np.ndarray, base: np.ndarray, hectares: np.ndarray | None = None
    ) -> None:
        """Merge one bounded input tile using conservative validity masks.

        Args:
            data: Float64 stored values in one tile.
            base: In-area valid source mask.
            hectares: Fractional cell hectares, required for an areaha reduction.
        """
        cache: dict[Node, tuple[Any, Any]] = {}

        def evaluate(node: Node) -> tuple[Any, Any]:
            """Evaluate one pixel subtree, retaining its validity.

            Args:
                node: Pixel expression or finite literal.

            Returns:
                Values and a boolean validity mask.
            """
            if node in cache:
                return cache[node]
            if node.op == "source":
                result = (data, base)
            elif node.op == "number":
                result = (np.float64(node.value), True)
            else:
                children = [evaluate(child) for child in node.args]
                valid: Any = True
                for _, mask in children:
                    valid = valid & mask
                with np.errstate(all="ignore"):
                    value = apply_operator(node, [child[0] for child in children])
                result = (value, valid & np.isfinite(value))
            cache[node] = result
            return result

        values, valid = evaluate(self.node.args[0])
        eligible = base & valid
        if len(self.node.args) == 2:
            condition, condition_valid = evaluate(self.node.args[1])
            valid = valid & condition_valid
            eligible = eligible & condition_valid & condition
        self.valid += int(np.count_nonzero(base))
        self.invalid += int(np.count_nonzero(base & ~np.asarray(valid, dtype=bool)))
        if self.node.args[0].boolean:
            eligible = eligible & values
        selected = (
            hectares[eligible]
            if self.node.op == "areaha"
            else np.broadcast_to(values, data.shape)[eligible]
        )
        count = selected.size
        prior_count = self.matched
        self.matched += count
        if (
            not count
            or self.node.op == "count"
            or (self.node.args[0].boolean and self.node.op != "areaha")
        ):
            return
        self.minimum = min(self.minimum, float(np.min(selected)))
        self.maximum = max(self.maximum, float(np.max(selected)))
        if self.node.op == "mean":
            scale = float(np.max(np.abs(selected)))
            block_mean = (
                0.0 if scale == 0 else float(np.sum(selected / scale) / count * scale)
            )
            self.mean = self.mean * (prior_count / self.matched) + block_mean * (
                count / self.matched
            )
        if self.node.op in {"sum", "areaha"}:
            with np.errstate(over="ignore", invalid="ignore"):
                partial = float(np.sum(selected, dtype=np.float64))
            corrected = partial - self.compensation
            total = self.total + corrected
            self.compensation = (total - self.total) - corrected
            self.total = total
            self.overflow |= not math.isfinite(total)

    def result(self) -> tuple[int | float | None, str]:
        """Return the aggregate value and explicit empty/error classification.

        Returns:
            Native numeric result (counts remain Python integers) and status.
        """
        if self.valid == 0:
            return None, "no_valid_data"
        if self.invalid == self.valid:
            return None, "invalid_arithmetic"
        if self.overflow:
            return None, "overflow"
        if self.node.op == "count" or (
            self.node.args[0].boolean and self.node.op != "areaha"
        ):
            return self.matched, "ok" if self.matched else "no_matches"
        if self.matched == 0:
            return (
                0.0
                if self.node.op == "areaha"
                else 0 if self.node.op == "sum" else None
            ), "no_matches"
        value = {
            "sum": self.total,
            "mean": self.mean,
            "min": self.minimum,
            "max": self.maximum,
            "areaha": self.total,
        }[self.node.op]
        return (value, "ok") if math.isfinite(value) else (None, "overflow")


class Calculation:
    """Evaluate one scalar expression with bounded per-aggregate state."""

    def __init__(self, root: Node) -> None:
        """Create accumulators for unique aggregate subexpressions.

        Args:
            root: Compiled scalar result expression.
        """
        self.root = root
        self.reductions = {
            node: Reduction(node) for node in walk(root) if node.op in FUNCTIONS
        }

    def process_tile(
        self,
        data: np.ndarray,
        valid: np.ndarray,
        hectares: np.ndarray | None = None,
        area_valid: np.ndarray | None = None,
    ) -> None:
        """Process one raster tile and accumulate its contribution to the result.

        Call result() after all tiles have been processed.

        Args:
            data: Raster pixel values for this tile.
            valid: Boolean mask selecting valid pixels inside the requested area.
            hectares: Selected area within each pixel, in hectares, for areaha.
            area_valid: Boolean mask selecting valid pixels with positive area.

        Raises:
            ValueError: If an area calculation has no hectare weights or area mask.
        """
        for reduction in self.reductions.values():
            if reduction.node.op == "areaha":
                if hectares is None or area_valid is None:
                    raise ValueError(
                        "Area reductions require fractional hectares and an area-validity mask"
                    )
                reduction.update(data, area_valid, hectares)
            else:
                reduction.update(data, valid)

    def result(self) -> dict[str, Any]:
        """Finalize a JSON-safe result without losing integer counts.

        Returns:
            Decimal-string value/type, state, and per-aggregate coverage counts.
        """
        reduced = {node: value.result() for node, value in self.reductions.items()}

        def scalar(node: Node) -> int | float:
            """Evaluate the remaining scalar expression.

            Args:
                node: Scalar operator, literal, or completed reduction.

            Returns:
                Finite scalar; division/domain failures are caught by the caller.
            """
            if node in reduced:
                return reduced[node][0]
            if node.op == "number":
                return node.value
            return apply_operator(node, [scalar(arg) for arg in node.args])

        state = next(
            (state for value, state in reduced.values() if value is None), "ok"
        )
        value = None
        if state == "ok":
            try:
                value = scalar(self.root)
                if not math.isfinite(value):
                    value, state = None, "overflow"
            except OverflowError:
                value, state = None, "overflow"
            except (ArithmeticError, TypeError, ValueError):
                value, state = None, "invalid_arithmetic"
            if state == "ok" and all(
                status == "no_matches" for _, status in reduced.values()
            ):
                state = "no_matches"
        return {
            "value": None if value is None else str(value),
            "unit": "ha" if self.root.op == "areaha" else None,
            "valueType": (
                None
                if value is None
                else ("integer" if isinstance(value, int) else "float")
            ),
            "state": state,
            "aggregates": [
                {
                    "function": node.op,
                    "validPixels": item.valid,
                    "matchedPixels": item.matched,
                    "invalidArithmeticPixels": item.invalid,
                    **({"unit": "ha"} if node.op == "areaha" else {}),
                }
                for node, item in self.reductions.items()
            ],
        }
