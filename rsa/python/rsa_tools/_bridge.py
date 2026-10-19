"""Internal JSON bridge. Discovery parses source only; invocation executes it."""

import ast
import contextlib
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sys
import traceback


EXCLUDED = {"logs", ".git", "node_modules", ".venv", "venv", "__pycache__"}


def annotation_schema(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        node = ast.parse(node.value, mode="eval").body
    if isinstance(node, ast.Constant) and node.value is None:
        return {"type": "null"}
    if isinstance(node, ast.Name) and node.id in {"str", "int", "float", "bool"}:
        return {"type": {"str": "string", "int": "integer", "float": "number", "bool": "boolean"}[node.id]}
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        left, right = annotation_schema(node.left), annotation_schema(node.right)
        if (left == {"type": "null"}) == (right == {"type": "null"}):
            raise ValueError("Only T | None unions are supported")
        return {"anyOf": [left, right]}
    if isinstance(node, ast.Subscript):
        name = node.value.id if isinstance(node.value, ast.Name) else None
        if isinstance(node.value, ast.Attribute) and isinstance(node.value.value, ast.Name) and node.value.value.id == "typing":
            name = node.value.attr
        item = node.slice
        if name in {"list", "List"}:
            return {"type": "array", "items": annotation_schema(item)}
        if name in {"dict", "Dict"} and isinstance(item, ast.Tuple) and len(item.elts) == 2:
            if annotation_schema(item.elts[0]) != {"type": "string"}:
                raise ValueError("Dictionary keys must be str")
            return {"type": "object", "additionalProperties": annotation_schema(item.elts[1])}
        if name == "Optional":
            return {"anyOf": [annotation_schema(item), {"type": "null"}]}
    raise ValueError("Unsupported annotation; use str, int, float, bool, list[T], dict[str, T], or Optional[T]/T | None")


def validate(value, schema, location="arguments"):
    if "anyOf" in schema:
        for branch in schema["anyOf"]:
            try:
                validate(value, branch, location)
                return
            except ValueError:
                pass
        raise ValueError(location + " does not match its optional type")
    kind = schema["type"]
    matches = {
        "null": value is None,
        "string": isinstance(value, str),
        "integer": type(value) is int,
        "number": type(value) in (int, float) and (not isinstance(value, float) or math.isfinite(value)),
        "boolean": type(value) is bool,
        "array": isinstance(value, list),
        "object": isinstance(value, dict),
    }
    if not matches[kind]:
        raise ValueError(location + " must be " + kind)
    if kind == "array":
        for index, item in enumerate(value):
            validate(item, schema["items"], "%s[%d]" % (location, index))
    if kind == "object":
        if any(not isinstance(key, str) for key in value):
            raise ValueError(location + " must have string keys")
        properties = schema.get("properties", {})
        for name in schema.get("required", []):
            if name not in value:
                raise ValueError(location + "." + name + " is required")
        for name, item in value.items():
            child_schema = properties.get(name, schema.get("additionalProperties"))
            if not child_schema:
                raise ValueError(location + "." + name + " is not a declared parameter")
            validate(item, child_schema, location + "." + name)


def function_schema(node):
    if isinstance(node, ast.AsyncFunctionDef):
        raise ValueError("Async capabilities are unsupported; use a synchronous function")
    if node.args.posonlyargs or node.args.vararg or node.args.kwarg:
        raise ValueError("Positional-only parameters, *args and **kwargs are unsupported")
    description = ast.get_docstring(node)
    if not description or not description.strip():
        raise ValueError("A capability must have a docstring describing its use")
    args = node.args.args + node.args.kwonlyargs
    defaults = [None] * (len(node.args.args) - len(node.args.defaults)) + node.args.defaults + node.args.kw_defaults
    properties, required = {}, []
    for argument, default in zip(args, defaults):
        if argument.annotation is None:
            raise ValueError("Parameter %s requires a supported type annotation" % argument.arg)
        schema = annotation_schema(argument.annotation)
        if default is None:
            required.append(argument.arg)
        else:
            try:
                value = ast.literal_eval(default)
                # Reject non-JSON literals before they can silently change shape.
                validate(value, schema, "Default for " + argument.arg)
                json.dumps(value, allow_nan=False)
            except (ValueError, TypeError) as error:
                raise ValueError("Parameter %s requires a JSON literal default matching its annotation: %s" % (argument.arg, error))
            schema = {**schema, "default": value}
        properties[argument.arg] = schema
    return description, {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


def marked_functions(tree):
    decorators, modules = set(), set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module == "rsa_tools":
            decorators.update(alias.asname or alias.name for alias in node.names if alias.name == "capability")
        if isinstance(node, ast.Import):
            modules.update(alias.asname or alias.name for alias in node.names if alias.name == "rsa_tools")
    def is_marker(node):
        if isinstance(node, ast.Call):
            node = node.func
        return (isinstance(node, ast.Name) and node.id in decorators) or (
            isinstance(node, ast.Attribute) and node.attr == "capability" and isinstance(node.value, ast.Name) and node.value.id in modules)
    return [(node, [item for item in node.decorator_list if is_marker(item)])
            for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and any(is_marker(item) for item in node.decorator_list)]


def declared_hook(markers):
    for marker in markers:
        if isinstance(marker, ast.Call):
            for keyword in marker.keywords:
                if keyword.arg == "hook":
                    return keyword.value.value if isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, str) else "<dynamic>"
    return None


def marker_hook(marker):
    if not isinstance(marker, ast.Call):
        return None
    if marker.args or len(marker.keywords) > 1 or any(keyword.arg != "hook" for keyword in marker.keywords):
        raise ValueError('Use @capability, @capability(), or @capability(hook="observe")')
    hook = declared_hook([marker])
    if marker.keywords and hook != "observe":
        raise ValueError('The only supported capability hook is the literal "observe"')
    return hook


def discover(workspace):
    capabilities, diagnostics = [], []
    for directory, folders, files in os.walk(workspace, followlinks=False):
        folders[:] = sorted(folder for folder in folders if folder not in EXCLUDED)
        for filename in sorted(files):
            if not filename.endswith(".py"):
                continue
            source = Path(directory) / filename
            relative = source.relative_to(workspace).as_posix()
            raw = None
            try:
                source.resolve().relative_to(workspace)
                raw = source.read_bytes()
                tree = ast.parse(raw, filename=relative)
            except (OSError, SyntaxError, ValueError) as error:
                # A broken ordinary helper is not itself an exposed capability.
                if raw is None or b"rsa_tools" in raw:
                    diagnostics.append({"path": relative, "line": getattr(error, "lineno", None), "message": str(error)})
                continue
            for node, markers in marked_functions(tree):
                hook = declared_hook(markers)
                try:
                    if node not in tree.body:
                        raise ValueError("Capabilities must be top-level functions, not methods or nested functions")
                    if len(markers) != 1 or len(node.decorator_list) != 1:
                        raise ValueError("A capability function must use only one @capability decorator")
                    marker = markers[0]
                    hook = marker_hook(marker)
                    if hook == "observe" and (node.args.posonlyargs or node.args.args or node.args.kwonlyargs or node.args.vararg or node.args.kwarg):
                        raise ValueError("An observe hook must have no parameters")
                    if sum(isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and item.name == node.name for item in tree.body) != 1:
                        raise ValueError("A capability function name must be unique within its source file")
                    description, parameters = function_schema(node)
                    identity = relative + ":" + node.name
                    name = re.sub(r"[^a-zA-Z0-9_]", "_", "python_" + relative[:-3] + "_" + node.name)[:53]
                    name += "_" + hashlib.sha256(identity.encode()).hexdigest()[:10]
                    capabilities.append({"id": name, "name": name, "description": description, "parameters": parameters,
                        "origin": {"path": relative, "function": node.name, "line": node.lineno}, "codeSHA": hashlib.sha256(raw).hexdigest(),
                        **({"hook": hook} if hook is not None else {})})
                except (ValueError, SyntaxError) as error:
                    diagnostics.append({"path": relative, "function": node.name, "line": node.lineno, "message": str(error),
                        **({"hook": hook} if hook is not None else {})})
    return {"capabilities": capabilities, "diagnostics": diagnostics}


def invoke(workspace, request):
    capability = request["capability"]
    validate(request["arguments"], capability["parameters"])
    source = (workspace / capability["origin"]["path"]).resolve()
    source.relative_to(workspace)
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != capability["codeSHA"]:
        raise ValueError("Capability source changed after discovery; refresh before invoking it")
    # -B prevents cache writes, but still reads existing timestamp-based pyc.
    # Give this call a nonexistent cache root so quick helper edits are fresh.
    # No directory is created because bytecode writes are disabled by the host.
    sys.pycache_prefix = str(workspace / "__pycache__" / ("rsa-" + os.urandom(12).hex()))
    sys.path[:0] = [str(source.parent), str(workspace)]
    parts = Path(capability["origin"]["path"]).with_suffix("").parts
    module_name = ".".join(parts[:-1] if parts[-1] == "__init__" else parts)
    if not module_name or not all(part.isidentifier() for part in module_name.split(".")):
        module_name = "_rsa_workspace_" + capability["id"]
    spec = importlib.util.spec_from_file_location(module_name, source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    # Compile the exact hashed bytes. Repeated calls cannot reuse stale bytecode.
    with invocation_output():
        exec(compile(raw, str(source), "exec"), module.__dict__)
        function = getattr(module, capability["origin"]["function"])
        if not callable(function) or not getattr(function, "__rsa_capability__", False):
            raise ValueError("The selected function is no longer marked @capability")
        result = function(**request["arguments"])
        # JSON is the tool result contract; incidental prints go to stderr.
        encoded = json.dumps({"ok": True, "result": result}, allow_nan=False)
    return encoded


@contextlib.contextmanager
def invocation_output():
    # Redirect the descriptor too, so subprocesses and native libraries cannot
    # mix incidental stdout into the bridge's single JSON reply.
    sys.stdout.flush()
    saved_stdout = os.dup(1)
    try:
        os.dup2(2, 1)
        with contextlib.redirect_stdout(sys.stderr):
            yield
    finally:
        sys.stderr.flush()
        os.dup2(saved_stdout, 1)
        os.close(saved_stdout)


def main():
    try:
        request = json.load(sys.stdin)
        workspace = Path(request["workspace"]).resolve()
        if request["action"] == "discover":
            print(json.dumps(discover(workspace), allow_nan=False))
        elif request["action"] == "invoke":
            print(invoke(workspace, request))
        else:
            raise ValueError("Unknown Python bridge action")
    except BaseException as error:
        print(json.dumps({"ok": False, "error": {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
