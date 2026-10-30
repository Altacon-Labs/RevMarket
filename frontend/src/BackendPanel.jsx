import {useEffect,useRef,useState} from 'react';
import {api,logoutActivity,signInActivity} from './lib/backend.mjs';
import PhosphorIcon from './icons/PhosphorIcon.jsx';

export default function BackendPanel({address,lastAction}){
  const [state,setState]=useState({online:false,profile:null,items:[],message:'Checking local activity service…'});
  const [busy,setBusy]=useState(false);
  const generation=useRef(0);
  const activeAddress=useRef(address);activeAddress.current=address;
  async function load(){
    const version=++generation.current;
    try{
      await api('/health');
      let profile=null,items=[];
      if(address){
        try{const me=await api('/me');if(me.wallet===address){profile=me;items=(await api('/activity')).items;}}
        catch(e){if(e.status!==401)throw e;}
      }
      if(version===generation.current)setState({online:true,profile,items,message:profile?'Signed in to off-chain activity tracking.':'Activity sign-in is optional. Market actions still use your wallet.'});
    }catch{if(version===generation.current)setState({online:false,profile:null,items:[],message:'Activity service offline. Start the backend to use profiles; on-chain market actions remain available.'});}
  }
  useEffect(()=>{setState(s=>({...s,profile:null,items:[]}));load();return()=>{generation.current++;};},[address,lastAction]);
  async function act(action){
    if(busy)return;
    const expected=address;
    setBusy(true);
    try{await action();if(activeAddress.current===expected)await load();}
    catch(e){if(activeAddress.current===expected)setState(s=>({...s,message:e.message}));}
    finally{setBusy(false);}
  }
  return <section className="automation-panel" aria-labelledby="activity-title">
    <div className="row"><h2 id="activity-title"><PhosphorIcon name="wallet" size={24}/>Activity profile</h2><span className="badge">{state.online?'Backend online':'Backend offline'}</span></div>
    <p>{state.message}</p>
    <p className="muted">A message signature proves control of your public signing key for this off-chain session. It does not authorize transactions, spending or automation. No email, password or private key is requested.</p>
    <div className="row">
      {!state.profile && <button disabled={!address||!state.online||busy} onClick={()=>act(()=>signInActivity(address,()=>activeAddress.current===address))}>Sign in to activity</button>}
      {state.profile && <button disabled={busy} onClick={()=>act(logoutActivity)}>Sign out of activity</button>}
      <button disabled={busy} onClick={()=>act(load)}><PhosphorIcon name="refresh"/>Refresh activity</button>
    </div>
    {state.profile && <details><summary>Recent reported actions ({state.items.length})</summary>
      <p className="muted">These records are reported by this app and are not independently verified against the chain. Positions and payouts are read from the contract.</p>
      {state.items.length===0?<p>No reported actions yet.</p>:<ul>{state.items.slice(0,5).map(item=><li key={item.id}>{item.action} · <code>{item.txHash.slice(0,12)}…</code></li>)}</ul>}
      <button disabled={busy} onClick={()=>{if(window.confirm('Delete this off-chain profile and its reported activity? On-chain data will remain.'))act(()=>api('/me',{method:'DELETE'}));}}>Delete off-chain profile</button>
    </details>}
  </section>;
}
