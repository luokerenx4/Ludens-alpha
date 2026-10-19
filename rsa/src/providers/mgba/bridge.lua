-- Load in mGBA 0.10.5: Tools > Scripting > File > Load script.
-- This is the only component that knows mGBA's input and frame APIs.
if RSA_BRIDGE then RSA_BRIDGE.close() end

-- mGBA 0.10.5 closes a socket again in its destructor without invalidating its fd.
-- Retain closed wrappers until emulator exit so GC cannot close a reused fd.
-- https://github.com/mgba-emu/mgba/blob/0.10.5/src/script/socket.c#L107
RSA_CLOSED_SOCKETS = RSA_CLOSED_SOCKETS or {}
local function closeSocket(sock)
    if not RSA_CLOSED_SOCKETS[sock] then
        RSA_CLOSED_SOCKETS[sock] = true
        sock:close()
    end
end

local port = RSA_BRIDGE_PORT or 47653
local server = assert(socket.bind("127.0.0.1", port))
assert(server:listen())
local client, input, output = nil, "", ""
local epoch, action, mask = nil, nil, 0
local callbackIds = {}
-- Match the exact integer range of the provider's JavaScript frame counts.
local maxSafeInteger = 9007199254740991

local function flush()
    if not client or #output == 0 then return end
    local n, err = client:send(output)
    if n then output = output:sub(n + 1)
    elseif err ~= socket.ERRORS.AGAIN then closeSocket(client); client = nil end
end

local function reply(id, status, ...)
    local fields = { id, status, ... }
    for i, v in ipairs(fields) do fields[i] = tostring(v):gsub("[\r\n\t]", " ") end
    output = output .. table.concat(fields, "\t") .. "\n"
    flush()
end

local function finish(status)
    local previous = action
    action, mask = nil, 0
    emu:setKeys(0)
    if previous then
        reply(previous.id, "OK", status, previous.startFrame, emu:currentFrame())
    end
end

local function disconnect()
    if epoch then finish("interrupted") end
    epoch = nil
    if client then closeSocket(client) end
    client, input, output = nil, "", ""
end

local function owned(value)
    assert(epoch and value == epoch, "STALE_EPOCH")
end

local function dispatch(fields)
    local id, op = fields[1], fields[2]
    if op == "HELLO" then
        reply(id, "OK", emu:frequency(), emu:frameCycles())
    elseif op == "CAPTURE" then
        local path = assert(fields[3], "missing path")
        emu:screenshot(path)
        reply(id, "OK", emu:currentFrame())
    elseif op == "OWN" then
        assert(not epoch, "ALREADY_OWNED")
        epoch = assert(fields[3], "missing epoch")
        mask = 0
        emu:setKeys(0)
        reply(id, "OK")
    elseif op == "DISOWN" then
        owned(fields[3])
        finish("interrupted")
        epoch = nil
        reply(id, "OK")
    elseif op == "STATE" then
        owned(fields[3])
        reply(id, "OK", mask, action and action.id or "-", emu:getKeys())
    elseif op == "STOP" then
        owned(fields[3])
        if not fields[4] or (action and action.id == fields[4]) then finish("interrupted") end
        reply(id, "OK")
    elseif op == "APPLY" then
        owned(fields[3])
        assert(not action, "BUSY")
        local spans, total = {}, 0
        for value in assert(fields[4], "missing sequence"):gmatch("[^,]+") do
            local keys, frames = value:match("^(%d+):(%d+)$")
            keys, frames = tonumber(keys), tonumber(frames)
            assert(keys and keys <= 1023 and frames and frames > 0 and frames <= maxSafeInteger, "invalid span")
            assert(frames <= maxSafeInteger - total, "invalid duration")
            total = total + frames
            table.insert(spans, { mask = keys, frames = frames })
        end
        local now = emu:currentFrame()
        assert(#spans > 0 and now >= 0 and now <= maxSafeInteger - total, "invalid duration")
        action = { id = id, spans = spans, index = 1, startFrame = now, endFrame = now + spans[1].frames }
        mask = spans[1].mask
        emu:setKeys(mask)
    else
        error("unknown command")
    end
end

local function receive()
    while client do
        -- Read only when ready: 0.10.5 may report stale AGAIN on EOF.
        -- Draining past readiness would make EOF indistinguishable from an empty buffer.
        local ready, readinessError = client:hasdata()
        if not ready then
            if readinessError then disconnect() end
            return
        end
        local chunk, err = client:receive(65536)
        if not chunk then
            disconnect()
            return
        end
        if #chunk == 0 then disconnect(); return end
        input = input .. chunk
        while true do
            local newline = input:find("\n", 1, true)
            if not newline then break end
            local line = input:sub(1, newline - 1)
            input = input:sub(newline + 1)
            local fields = {}
            for field in line:gmatch("[^\t]+") do table.insert(fields, field) end
            local ok, message = pcall(dispatch, fields)
            if not ok then reply(fields[1] or "?", "ERROR", message) end
        end
    end
end

server:add("received", function()
    local incoming = server:accept()
    if not incoming then return end
    if client then closeSocket(incoming); return end
    client = incoming
    client:add("received", receive)
    client:add("error", disconnect)
end)

table.insert(callbackIds, callbacks:add("frame", function()
    if action and emu:currentFrame() >= action.endFrame then
        action.index = action.index + 1
        local span = action.spans[action.index]
        if span then
            action.endFrame = action.endFrame + span.frames
            mask = span.mask
            emu:setKeys(mask)
        else finish("completed") end
    end
    flush()
    if not client and epoch then disconnect() end
end))

-- Qt may reapply native keys every frame. Override at the actual read boundary.
table.insert(callbackIds, callbacks:add("keysRead", function()
    if epoch then emu:setKeys(mask) end
end))
table.insert(callbackIds, callbacks:add("reset", disconnect))
table.insert(callbackIds, callbacks:add("stop", disconnect))

RSA_BRIDGE = { close = function()
    disconnect()
    closeSocket(server)
    for _, id in ipairs(callbackIds) do callbacks:remove(id) end
end }
console:log("RSA bridge listening on 127.0.0.1:" .. port .. " (manual)")
