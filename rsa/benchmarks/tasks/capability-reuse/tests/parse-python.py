"""Parse recorded code, never import or execute the agent's workspace."""
import ast
import json
import re
import shlex
import sys


def functions(source):
    tree = ast.parse(source)
    # Exclude modules that run device operations on import: orders must be
    # attributable to the explicit helper invocation below.
    passive = all(isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef))
                  or isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
                  for node in tree.body)
    return {"functions": [node.name for node in tree.body if isinstance(node, ast.FunctionDef)],
            "effectfulFunctions": [node.name for node in tree.body if isinstance(node, ast.FunctionDef)
                                   and any(isinstance(child, ast.Call) for statement in node.body for child in ast.walk(statement))],
            "passiveModule": passive}


def invocation(command):
    heredoc = re.fullmatch(r"\s*(?:\S*/)?python(?:3(?:\.\d+)?)?\s+-\s*<<\s*(['\"])(\w+)\1\n(.*)\n\2\s*", command, re.S)
    if heredoc:
        source = heredoc[3]
    else:
        argv = shlex.split(command)
        if len(argv) != 3 or not re.fullmatch(r"(?:.*/)?python(?:3(?:\.\d+)?)?", argv[0]) or argv[1] != "-c":
            return None
        source = argv[2]
    tree = ast.parse(source)
    aliases = {}
    expressions = []
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and not node.level and node.module:
            for name in node.names:
                aliases[name.asname or name.name] = f"{node.module}.{name.name}"
        elif isinstance(node, ast.Import):
            for name in node.names:
                aliases[name.asname or name.name.split('.')[0]] = name.name if name.asname else name.name.split('.')[0]
        else:
            expressions.append(node)
    # A single direct call, optionally printed/indexed. Complex shell scripts or
    # Python control flow remain unassessed, rather than guessed from text matches.
    if len(expressions) != 1 or not isinstance(expressions[0], ast.Expr):
        return None
    value = expressions[0].value
    if isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == "print" and "print" not in aliases:
        if len(value.args) != 1 or value.keywords:
            return None
        value = value.args[0]
    if isinstance(value, ast.Subscript):
        ast.literal_eval(value.slice)
        value = value.value
    if not isinstance(value, ast.Call):
        return None
    for arg in value.args:
        ast.literal_eval(arg)
    for arg in value.keywords:
        if arg.arg is None:
            return None
        ast.literal_eval(arg.value)
    name = value.func
    suffix = []
    while isinstance(name, ast.Attribute):
        suffix.insert(0, name.attr)
        name = name.value
    if not isinstance(name, ast.Name) or name.id not in aliases:
        return None
    qualified = '.'.join([aliases[name.id], *suffix]).split('.')
    return {"path": '/'.join(qualified[:-1]) + '.py', "function": qualified[-1]}


def parse(item):
    try:
        return {"seq": item["seq"], **(functions(item["source"]) if "source" in item else {"call": invocation(item["command"])})}
    except (SyntaxError, ValueError, TypeError):
        return {"seq": item["seq"], "unassessed": True}


json.dump([parse(item) for item in json.load(sys.stdin)], sys.stdout)
