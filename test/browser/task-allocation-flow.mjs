import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function seedAllocationFlow(service, teamId, memberId, call) {
  const {store,history}=service.runtime;
  clearInterval(service.runtime.timer);
  const createPreset=name=>call('/teams/'+teamId+'/resources',{name,description:'',config:{harness:'codex',model:'allocation-model',access:'read-only'}});
  const preset=await createPreset('Allocation fixture A');
  await createPreset('Allocation fixture B');
  const chat=history.mainConversation(teamId);
  let host;
  store.teams.recordMessage(teamId,chat,'Allocation list fixture',randomUUID(),message=>{
    host=store.enqueueHost(teamId,chat,message.id,true,false);
  });
  const run=store.get('runs',teamId,host.runId);
  store.setStatus(host,'submitted');
  const task=store.createWork(run,memberId,'Allocate fixture work','Test task-specific allocation',[],[],[]);
  store.setStatus(task,'failed');
  const mail=store.createWork(run,memberId,'Communication fixture','Test communication history',[],[],[]);
  mail.interaction={messageIds:[randomUUID()]};store.setStatus(mail,'failed');
  return {preset,task,mail};
}

export async function verifyAllocationFlow(page, dialog, service, teamId, fixture, reopen) {
  const {task,preset,mail}=fixture;
  const queue=()=>page.getByRole('region',{name:'Task resources',exact:true});
  const row=()=>queue().getByRole('listitem').filter({hasText:task.title});
  const getWork=()=>service.runtime.store.get('works',teamId,task.id);
  const waitWrite=async(suffix,action)=>{
    const [response]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname.endsWith(suffix)&&r.request().method()!=='GET'),action()]);
    assert(response.ok(),await response.text());
  };
  assert.equal(await queue().getByRole('listitem').count(),1);
  await row().getByRole('button',{name:'Set task resource'}).click();
  await page.getByRole('menuitem',{name:'Codex',exact:true}).click();
  await page.getByRole('menuitem',{name:'allocation-model',exact:true}).click();
  await page.getByRole('menuitem',{name:preset.name,exact:true}).click();
  await waitWrite('/works/'+task.id+'/allocation',()=>row().getByRole('button',{name:'Apply',exact:true}).click());
  assert.equal(getWork().selection.resourceId,preset.id);
  await row().getByText('Configuration details',{exact:true}).click();
  await row().getByText('Resource version 1',{exact:true}).waitFor();
  await waitWrite('/allocation-list',()=>row().getByRole('button',{name:'Remove from list',exact:true}).click());
  await queue().getByText('No tasks need allocation or retry.',{exact:true}).waitFor();
  await page.reload();
  await reopen();
  await queue().getByText('No tasks need allocation or retry.',{exact:true}).waitFor();
  await queue().getByText('Removed from this list (1)',{exact:true}).click();
  await waitWrite('/allocation-list',()=>queue().getByRole('button',{name:'Restore to list'}).click());
  assert.equal(getWork().status,'failed');
  assert.equal(getWork().selection.resourceId,preset.id);
  assert.equal(await row().getByRole('button',{name:'Retry',exact:true}).isEnabled(),true);
  const card=dialog.locator('.resource-row').filter({hasText:preset.name});
  await card.getByRole('button',{name:'Remove',exact:true}).click();
  const [blocked]=await Promise.all([page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().endsWith(preset.id)),card.getByRole('button',{name:'Confirm deletion'}).click()]);
  assert.equal(blocked.status(),409);
  await card.getByRole('alert').waitFor();
  await waitWrite('/works/'+task.id+'/allocation',()=>row().getByRole('button',{name:'Remove task override'}).click());
  assert.equal(getWork().selection,undefined);
  await row().getByText('Inherited from member default',{exact:true}).waitFor();
  await card.getByRole('button',{name:'Remove',exact:true}).click();
  await waitWrite('/resources/'+preset.id,()=>card.getByRole('button',{name:'Confirm deletion'}).click());
  await card.waitFor({state:'detached'});
  assert.equal(service.runtime.store.get('works',teamId,mail.id).status,'failed');
}
