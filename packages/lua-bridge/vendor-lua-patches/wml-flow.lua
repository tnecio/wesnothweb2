local utils = wesnoth.require "wml-utils"
local wml_actions = wesnoth.wml_actions

function wml_actions.command(cfg)
	utils.handle_event_commands(cfg, "plain")
end

-- we can't create functions with names that are Lua keywords (eg if, while)
-- instead, we store the following anonymous functions directly into
-- the table, using the [] operator, rather than by using the point syntax

wml_actions["if"] = function(cfg)
	if not (wml.get_child(cfg, 'then') or wml.get_child(cfg, 'elseif') or wml.get_child(cfg, 'else')) then
		wml.error("[if] didn't find any [then], [elseif], or [else] children.")
	end

	if wml.eval_conditional(cfg) then -- evaluate [if] tag
		for then_child in wml.child_range(cfg, "then") do
			local action = utils.handle_event_commands(then_child, "conditional")
			if action ~= "none" then break end
		end
		return -- stop after executing [then] tags
	end

	for elseif_child in wml.child_range(cfg, "elseif") do
		if wml.eval_conditional(elseif_child) then -- we'll evaluate the [elseif] tags one by one
			for then_tag in wml.child_range(elseif_child, "then") do
				local action = utils.handle_event_commands(then_tag, "conditional")
				if action ~= "none" then break end
			end
			return -- stop on first matched condition
		end
	end

	-- no matched condition, try the [else] tags
	for else_child in wml.child_range(cfg, "else") do
		local action = utils.handle_event_commands(else_child, "conditional")
		if action ~= "none" then break end
	end
end

wml_actions["while"] = function( cfg )
	if wml.child_count(cfg, "do") == 0 then
		wml.error "[while] does not contain any [do] tags"
	end

	-- execute [do] up to 65536 times
	for i = 1, 65536 do
		if wml.eval_conditional( cfg ) then
			for do_child in wml.child_range( cfg, "do" ) do
				local action = utils.handle_event_commands(do_child, "loop")
				if action == "break" then
					utils.set_exiting("none")
					return
				elseif action == "continue" then
					utils.set_exiting("none")
					break
				elseif action ~= "none" then
					return
				end
			end
		else return end
	end
end

wml_actions["break"] = function(cfg)
	utils.set_exiting("break")
end

wml_actions["return"] = function(cfg)
	utils.set_exiting("return")
end

function wml_actions.continue(cfg)
	utils.set_exiting("continue")
end

wesnoth.wml_actions["for"] = function(cfg)
	if wml.child_count(cfg, "do") == 0 then
		wml.error "[for] does not contain any [do] tags"
	end

	local loop_lim = {}
	local first
	if cfg.array ~= nil then
		if cfg.reverse then
			first = wml.variables[cfg.array .. ".length"] - 1
			loop_lim.last = 0
			loop_lim.step = -1
		else
			first = 0
			loop_lim.last = '$($' .. cfg.array .. ".length - 1)"
			loop_lim.step = 1
		end
	else
		-- Get a literal config to fetch end and step;
		-- this done is to delay expansion of variables
		local cfg_lit = wml.literal(cfg)
		first = cfg.start or 0
		loop_lim.last = cfg_lit["end"] or first
		loop_lim.step = cfg_lit.step or 1
	end
	loop_lim = wml.tovconfig(loop_lim)
	if loop_lim.step == 0 then -- Sanity check
		wml.error("[for] has a step of 0!")
	end
	if (first < loop_lim.last and loop_lim.step <= 0)
			or (first > loop_lim.last and loop_lim.step >= 0) then
		-- Sanity check: If they specify something like start,end,step=1,4,-1
		-- then we do nothing
		return
	end
	local i_var = cfg.variable or "i"
	-- Lua 5.4 `<close>` rewritten as explicit pcall-based cleanup for Fengari
	-- (Lua 5.3) compatibility -- see packages/lua-bridge/vendor-lua-patches/README.md.
	-- The `goto exit`s below used to jump to a label placed just before this
	-- function's closing `end`, i.e. still inside `save_i`'s original scope --
	-- they never needed to trigger an early close, so replacing them with a
	-- plain `return` (exiting the wrapping anonymous function below) preserves
	-- that behavior exactly.
	local save_i = utils.scoped_var(i_var)
	local __ok, __err = pcall(function()
	wml.variables[i_var] = first
	local function loop_condition()
		local sentinel = loop_lim.last
		if loop_lim.step then
			sentinel = sentinel + loop_lim.step
			if loop_lim.step > 0 then
				return wml.variables[i_var] < sentinel
			else
				return wml.variables[i_var] > sentinel
			end
		elseif loop_lim.last < first then
			sentinel = sentinel - 1
			return wml.variables[i_var] > sentinel
		else
			sentinel = sentinel + 1
			return wml.variables[i_var] < sentinel
		end
	end
	while loop_condition() do
		for do_child in wml.child_range( cfg, "do" ) do
			local action = utils.handle_event_commands(do_child, "loop")
			if action == "break" then
				utils.set_exiting("none")
				return
			elseif action == "continue" then
				utils.set_exiting("none")
				break
			elseif action ~= "none" then
				return
			end
		end
		wml.variables[i_var] = wml.variables[i_var] + loop_lim.step
	end
	end) -- end of body wrapped for `save_i`'s <close>-equivalent cleanup
	local __close = debug.getmetatable(save_i).__close
	__close(save_i, __ok and nil or __err)
	if not __ok then error(__err, 0) end
end

wml_actions["repeat"] = function(cfg)
	if wml.child_count(cfg, "do") == 0 then
		wml.error "[repeat] does not contain any [do] tags"
	end

	local times = cfg.times or 1
	for i = 1, times do
		for do_child in wml.child_range( cfg, "do" ) do
			local action = utils.handle_event_commands(do_child, "loop")
			if action == "break" then
				utils.set_exiting("none")
				return
			elseif action == "continue" then
				utils.set_exiting("none")
				break
			elseif action ~= "none" then
				return
			end
		end
	end
end

function wml_actions.foreach(cfg)
	if wml.child_count(cfg, "do") == 0 then
		wml.error "[foreach] does not contain any [do] tags"
	end

	local array_name = cfg.array or wml.error "[foreach] missing required array= attribute"
	local array = wml.array_variables[array_name]
	if #array == 0 then return end -- empty and scalars unwanted
	local item_name = cfg.variable or "this_item"
	local i_name = cfg.index_var or "i"

	-- Some protection against unsupported modification of the array while iterating. Changes to
	-- via the WML variable named array_name will be ignored during the loop, and then overwritten
	-- by the contents of "array" afterwards. The check_for_modifications is just trying to add an
	-- error message instead of silently ignoring those changes.
	local array_length = wml.variables[array_name .. ".length"]
	local check_for_modifications = true
	if array_name:find("^" .. item_name) then
		-- Disable the check for WML such as [for]array=this_item or [for]array=this_item.abilities,
		-- where the current item is shadowing the variable of the same name outside the loop.
		check_for_modifications = false
	end

	do
		-- Lua 5.4 `<close>` rewritten as explicit pcall-based cleanup for Fengari
		-- (Lua 5.3) compatibility -- see packages/lua-bridge/vendor-lua-patches/README.md.
		-- The `goto exit`s below used to jump past the end of this `do` block
		-- (to a label after it), which in real Lua 5.4 *does* trigger an
		-- early close of both `<close>` locals -- so they're replaced with
		-- `return` (exiting the wrapping anonymous function), and both
		-- variables are explicitly closed below in the same reverse
		-- declaration order Lua itself uses (`i` before `this_item`) whether
		-- the loop finished normally, hit break/continue/return, or errored.
		local this_item = utils.scoped_var(item_name)
		local i = utils.scoped_var(i_name)

		local __ok, __err = pcall(function()
		for index, value in ipairs(array) do
			wml.variables[item_name] = value
			-- set index variable
			wml.variables[i_name] = index-1 -- here -1, because of WML array
			-- perform actions
			for do_child in wml.child_range(cfg, "do") do
				local action = utils.handle_event_commands(do_child, "loop")
				if action == "break" then
					utils.set_exiting("none")
					return
				elseif action == "continue" then
					utils.set_exiting("none")
					break
				elseif action ~= "none" then
					return
				end
			end

			-- Update the copy which will eventually be written back to the
			-- array, in case the author made some modifications.
			if not cfg.readonly then
				array[index] = wml.variables[item_name]
			end

			if check_for_modifications and array_length ~= wml.variables[array_name .. ".length"] then
				wml.error("WML array length changed during [foreach] iteration")
			end
		end
	end) -- end of body wrapped for `this_item`/`i`'s <close>-equivalent cleanup
		-- close in reverse declaration order (i, then this_item), matching Lua 5.4's <close> semantics
		local __close_i = debug.getmetatable(i).__close
		__close_i(i, __ok and nil or __err)
		local __close_item = debug.getmetatable(this_item).__close
		__close_item(this_item, __ok and nil or __err)
		if not __ok then error(__err, 0) end
	end

	--[[
		This forces the readonly key to be taken literally.

		If readonly=yes, then this line guarantees that the array
		is unchanged after the [foreach] loop ends.

		If readonly=no, then this line updates the array with any
		changes the user has applied through the $this_item
		variable (or whatever variable was given in item_var).

		Note that altering the array via indexing (with the index_var)
		is not supported; any such changes will be reverted by this line.
	]]
	wml.array_variables[array_name] = array
end

function wml_actions.switch(cfg)
	local var_value = wml.variables[cfg.variable]
	local found = false

	-- Execute all the [case]s where the value matches.
	for v in wml.child_range(cfg, "case") do
		for _,w in ipairs(tostring(v.value):split()) do
			if w == tostring(var_value) then
				local action = utils.handle_event_commands(v, "switch")
				found = true
				if action ~= "none" then goto exit end
				break
			end
		end
	end
	::exit::

	-- Otherwise execute [else] statements.
	if not found then
		for v in wml.child_range(cfg, "else") do
			local action = utils.handle_event_commands(v, "switch")
			if action ~= "none" then break end
		end
	end
end
