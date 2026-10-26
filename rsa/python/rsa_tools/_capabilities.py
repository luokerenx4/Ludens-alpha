"""Workspace capability discovery and in-process loading."""

import ast
import hashlib
import importlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sys


EXCLUDED = {"logs", ".rsa", ".git", "node_modules", ".venv", "venv", "__pycache__"}


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


def function_schema(node, kind="capability"):
    if isinstance(node, ast.AsyncFunctionDef):
        raise ValueError("Async %s are unsupported; use a synchronous function" % ("capabilities" if kind == "capability" else "benchmarks"))
    if node.args.posonlyargs or node.args.vararg or node.args.kwarg:
        raise ValueError("Positional-only parameters, *args and **kwargs are unsupported")
    description = ast.get_docstring(node)
    if not description or not description.strip():
        raise ValueError("A %s must have a docstring describing its use" % kind)
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


def marked_functions(tree, marker_name="capability"):
    decorators, modules = set(), set()
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module == "rsa_tools":
            decorators.update(alias.asname or alias.name for alias in node.names if alias.name == marker_name)
        if isinstance(node, ast.Import):
            modules.update(alias.asname or alias.name for alias in node.names if alias.name == "rsa_tools")
    def is_marker(node):
        if isinstance(node, ast.Call):
            node = node.func
        return (isinstance(node, ast.Name) and node.id in decorators) or (
            isinstance(node, ast.Attribute) and node.attr == marker_name and isinstance(node.value, ast.Name) and node.value.id in modules)
    return [(node, [item for item in node.decorator_list if is_marker(item)])
            for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and any(is_marker(item) for item in node.decorator_list)]


def workspace_sources(workspace, diagnostics):
    """Read ordinary workspace sources without importing or following links."""
    workspace = Path(workspace).resolve()
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
            yield relative, raw, tree


def discover(workspace):
    capabilities, diagnostics = [], []
    for relative, raw, tree in workspace_sources(workspace, diagnostics):
        for node, markers in marked_functions(tree):
            try:
                if node not in tree.body:
                    raise ValueError("Capabilities must be top-level functions, not methods or nested functions")
                if len(markers) != 1 or len(node.decorator_list) != 1:
                    raise ValueError("A capability function must use only one @capability decorator")
                marker = markers[0]
                if isinstance(marker, ast.Call) and (marker.args or marker.keywords):
                    raise ValueError("Use @capability or @capability() without decorator arguments")
                if sum(isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and item.name == node.name for item in tree.body) != 1:
                    raise ValueError("A capability function name must be unique within its source file")
                description, parameters = function_schema(node)
                identity = relative + ":" + node.name
                name = re.sub(r"[^a-zA-Z0-9_]", "_", "python_" + relative[:-3] + "_" + node.name)[:53]
                name += "_" + hashlib.sha256(identity.encode()).hexdigest()[:10]
                capabilities.append({"id": name, "name": name, "description": description, "parameters": parameters,
                    "origin": {"path": relative, "function": node.name, "line": node.lineno}, "codeSHA": hashlib.sha256(raw).hexdigest()})
            except (ValueError, SyntaxError) as error:
                diagnostics.append({"path": relative, "function": node.name, "line": node.lineno, "message": str(error)})
    return {"capabilities": capabilities, "diagnostics": diagnostics}


def load_function(workspace, relative_path, function_name, *, raw=None, marker="capability"):
    """Load a marked function once, sharing ordinary Python imports by file."""
    workspace = Path(workspace).resolve()
    source = (workspace / relative_path).resolve()
    source.relative_to(workspace)

    def imported_module():
        for module in tuple(sys.modules.values()):
            filename = getattr(module, "__file__", None)
            if filename and Path(filename).resolve() == source:
                return module
        return None

    module = imported_module()
    if module is None:
        for entry in (str(workspace), str(source.parent)):
            if entry not in sys.path:
                sys.path.insert(0, entry)
        parts = source.relative_to(workspace).with_suffix("").parts
        module_name = ".".join(parts[:-1] if parts[-1] == "__init__" else parts)
        if not module_name or not all(part.isidentifier() for part in module_name.split(".")) or module_name in sys.modules:
            module_name = "_rsa_workspace_" + hashlib.sha256(str(source).encode()).hexdigest()[:16]
        parent_name, _, child_name = module_name.rpartition(".")
        parent = importlib.import_module(parent_name) if parent_name else None
        # A package's __init__ may itself import the selected module.
        module = imported_module()
        if module is None:
            raw = source.read_bytes() if raw is None else raw
            spec = importlib.util.spec_from_file_location(module_name, source)
            module = importlib.util.module_from_spec(spec)
            module.__rsa_source_sha__ = hashlib.sha256(raw).hexdigest()
            module.__rsa_source_bytes__ = raw
            sys.modules[module_name] = module
            try:
                exec(compile(raw, str(source), "exec"), module.__dict__)
            except BaseException:
                del sys.modules[module_name]
                raise
            if parent is not None:
                setattr(parent, child_name, module)
    function = getattr(module, function_name)
    if not callable(function) or not getattr(function, "__rsa_%s__" % marker, False):
        raise ValueError("The selected function is not marked @%s" % marker)
    return function


def call_local(workspace, capability_id, arguments):
    """Call a workspace function in this process, preserving Python objects."""
    relative_path, separator, function_name = capability_id.removeprefix("python/").rpartition(":")
    if not capability_id.startswith("python/") or not separator or not relative_path.endswith(".py") or not function_name.isidentifier():
        raise ValueError("Python capability IDs use python/path.py:function")
    return load_function(workspace, relative_path, function_name)(**arguments)
