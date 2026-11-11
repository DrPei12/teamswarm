import assert from "node:assert/strict";
import test from "node:test";
import { NativeHarness } from "../src/runtime/harness/native.js";
import { CodexHarness } from "../src/runtime/harness/codex.js";
import { readOnlyExecution, validateNativePermissions } from "../src/runtime/harness/permissions.js";
import { nativeAccess, openCodePermissions, openCodePermissionOptions } from "../src/runtime/permission-options.js";
import { memberPermissionChoices } from "../src/runtime/member-permissions.js";
import { executionConfig } from "../src/runtime/validation.js";
import { executionConfiguration } from "../src/runtime/execution-status.js";

test("every built-in member menu offers read-only and real full access without a workspace-only substitute", () => {
  for (const harness of [new CodexHarness(), ...(["claude-code","grok","pi","deepseek-harness","opencode"] as const).map(id=>new NativeHarness(id))]) {
    assert.deepEqual(memberPermissionChoices(harness).map(o=>o.id),["read-only","full-access"],harness.id);
    const permissions=harness.permissionOptions!().options.find(o=>o.id === "full-access")!.permissions;
    const config=executionConfig.parse({harness:harness.id,access:"workspace-write",permissions});
    validateNativePermissions(config);assert.equal(nativeAccess(config),"full-access",harness.id);
    assert.equal(executionConfiguration(config).nativeAccess,"full-access");
    assert.equal(nativeAccess(readOnlyExecution(config)),"read-only");
  }
  assert.deepEqual(memberPermissionChoices().map(o=>o.id),["read-only"]);
});
test("OpenCode full access permits external directories while bounded and read-only choices retain their boundary",()=>{
 const full=executionConfig.parse({harness:"opencode",permissions:openCodePermissionOptions.options.find(o=>o.id==='full-access')!.permissions});
 assert.equal(openCodePermissions(full,true).external_directory,"allow");
 assert.equal(openCodePermissions(readOnlyExecution(full),false).external_directory,"deny");
 const bounded=executionConfig.parse({harness:"opencode",permissions:openCodePermissionOptions.options.find(o=>o.id==='auto')!.permissions});
 assert.equal(openCodePermissions(bounded,true).external_directory,"deny");
 const custom=executionConfig.parse({harness:"opencode",permissions:{harness:"opencode",permission:{"*":"allow",external_directory:"deny"}}});
 assert.equal(nativeAccess(custom),"workspace-write");
});
