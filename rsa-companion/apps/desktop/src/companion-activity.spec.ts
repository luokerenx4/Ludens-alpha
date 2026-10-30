import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const handlers = vi.hoisted(()=>new Map<string, (event:unknown,input?:unknown)=>unknown>())
const state = vi.hoisted(()=>({home:''}))
vi.mock('electron',()=>({app:{getPath:()=>state.home},ipcMain:{handle:(name:string,fn:(event:unknown,input?:unknown)=>unknown)=>handlers.set(name,fn),removeHandler:(name:string)=>handlers.delete(name)}}))
import { installCompanionActivity } from './companion-activity.js'
import type { LogBlock } from './rsa-source.js'
function windowStub(){const frame={};const contents=Object.assign(new EventEmitter(),{mainFrame:frame,send:vi.fn()});return Object.assign(new EventEmitter(),{webContents:contents,isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false,restore:vi.fn(),show:vi.fn(),focus:vi.fn()})}
afterEach(()=>{vi.useRealTimers();handlers.clear();if(state.home)rmSync(state.home,{recursive:true,force:true})})
describe('companion notification IPC',()=>{
  it('allows new speech after hiding and showing the pet with the owner hidden',async()=>{
    vi.useFakeTimers();state.home=mkdtempSync(join(tmpdir(),'rsa-ipc-'))
    const owner=windowStub(),pet=windowStub();owner.isVisible=()=>false
    const activity=installCompanionActivity(owner as never,pet as never)
    let blocks:LogBlock[]=[{id:'tool:1',at:'1',kind:'tool',title:'工具',text:'Inspect the current screen',status:'running'}]
    activity.configure({identity:()=> 'workspace',read:async()=>({
      identity:'run:epoch',activity:'running',mode:'delta',revision:blocks.length,hasMore:false,
      blocks:blocks.map((block,index)=>({...block,createdRevision:index+1,revision:blocks.length})),current:{workspace:'/workspace',runId:'run',epoch:'epoch',
      phase:'等待模型',intent:blocks.at(-1)!.text,observationUrl:null,updatedAt:null,error:null,dashboardUrl:'http://127.0.0.1:3015'},
    })})
    await vi.advanceTimersByTimeAsync(0)
    const displays=()=>pet.webContents.send.mock.calls.filter(([channel,event])=>channel==='ludens:activity:display'&&event.type==='show').length
    expect(displays()).toBe(1)
    pet.isVisible=()=>false;pet.emit('hide')
    await vi.advanceTimersByTimeAsync(2500)
    const hidden=displays()
    pet.isVisible=()=>true;pet.emit('show')
    blocks=[{...blocks[0],status:'complete'},{...blocks[0],id:'tool:2',at:'2',text:'Continue the conversation',status:'complete'}]
    await vi.advanceTimersByTimeAsync(8000)
    expect(displays()).toBeGreaterThan(hidden)
    expect(pet.webContents.send.mock.calls.some(([channel,event])=>channel==='ludens:activity:display'
      &&event.type==='show'&&event.input.description==='Continue the conversation')).toBe(true)
    pet.emit('closed')
  })
  it('accepts only owning main frame settings and rejects subframes/other windows; no URL/code actions',async()=>{
    vi.useFakeTimers();state.home=mkdtempSync(join(tmpdir(),'rsa-ipc-'));const owner=windowStub(),pet=windowStub();installCompanionActivity(owner as never,pet as never)
    const event={sender:owner.webContents,senderFrame:owner.webContents.mainFrame}
    const get=handlers.get('ludens:activity:preferences')!;expect(get(event)).toMatchObject({blocks:{thinking:true,tool:true,diagnostic:false},brief:false})
    expect(()=>get({...event,senderFrame:{}})).toThrow('Unauthorized')
    expect(()=>get({sender:pet.webContents,senderFrame:pet.webContents.mainFrame})).toThrow('Unauthorized')
    const update=handlers.get('ludens:activity:update-preferences')!;await expect(update(event,{enabled:'yes'})).rejects.toThrow()
    await expect(update(event,{blocks:{diagnostic:true}})).resolves.toMatchObject({blocks:{diagnostic:true}})
    const open=handlers.get('ludens:activity:open')!;expect(open(event,{url:'javascript:evil'})).toBe(false)
    expect(()=>open({...event,senderFrame:{}},'anything')).toThrow('Unauthorized')
    pet.emit('closed');expect(handlers.size).toBe(0)
  })
  it('ignores destroyed owner state during transitions and pet retirement',()=>{
    vi.useFakeTimers();state.home=mkdtempSync(join(tmpdir(),'rsa-ipc-'))
    const owner=windowStub(),pet=windowStub()
    installCompanionActivity(owner as never,pet as never)
    owner.isDestroyed=()=>true
    owner.isVisible=()=>{throw new Error('Object has been destroyed')}
    owner.isMinimized=()=>{throw new Error('Object has been destroyed')}
    expect(()=>owner.emit('hide')).not.toThrow()
    pet.isDestroyed=()=>true
    expect(()=>pet.emit('closed')).not.toThrow()
    expect(handlers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('applies the Dashboard origin guard to owner settings IPC',()=>{
    vi.useFakeTimers();state.home=mkdtempSync(join(tmpdir(),'rsa-origin-'))
    const owner=windowStub(),pet=windowStub()
    let trustedOrigin = true
    installCompanionActivity(owner as never,pet as never,{trustedOwner:()=>trustedOrigin})
    const event={sender:owner.webContents,senderFrame:owner.webContents.mainFrame}
    const get=handlers.get('ludens:activity:preferences')!
    expect(get(event)).toMatchObject({brief:false})
    trustedOrigin=false
    expect(()=>get(event)).toThrow('Unauthorized')
    pet.emit('closed')
  })
})
