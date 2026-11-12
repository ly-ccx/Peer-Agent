/** Owned fixture only. Heap capture forces GC, so it must follow every timed read. */
export function captureFixtureLayout(normalizer,file){
  if(!globalThis.__ri00CpuGuard||!globalThis.__ri00CpuHost)throw new Error('heap_layout_requires_owned_fixture');
  const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path'),v8=process.getBuiltinModule('v8');
  if(path.basename(file)!=='layout.private.heapsnapshot'||fs.existsSync(file))throw new Error('new_private_layout_file_required');
  const records=this.records;
  if(!Array.isArray(records)||!records.length||records.length>100000)throw new Error('bounded_layout_source_required');
  if(Object.hasOwn(globalThis,'__ri00LayoutSelectedSamples'))throw new Error('layout_owner_exists');
  globalThis.__ri00LayoutSelectedSamples=Array.from({length:64},(_,i)=>{
    const raw=records[Math.floor(i*records.length/64)];return {raw,output:normalizer(raw)};
  });
  try{
    v8.writeHeapSnapshot(file,{exposeInternals:true,exposeNumericValues:false});fs.chmodSync(file,0o600);
    return {kind:'post_measurement_owned_fixture_heap_layout',samples:64,bytes:fs.statSync(file).size,forcesGc:true,notActualAppHeap:true};
  }finally{delete globalThis.__ri00LayoutSelectedSamples;}
}

/** Extract sizes/types only; never return addresses, object names or property values. */
export function summarizeFixtureLayout(snapshot){
  const meta=snapshot.snapshot?.meta,nf=meta?.node_fields,ef=meta?.edge_fields;
  if(!nf||!ef||!['type','name','self_size','edge_count'].every(x=>nf.includes(x))||!['type','name_or_index','to_node'].every(x=>ef.includes(x)))throw new Error('unsupported_heap_layout_schema');
  const {nodes,edges,strings}=snapshot,ns=nf.length,es=ef.length,ni=Object.fromEntries(nf.map((x,i)=>[x,i])),ei=Object.fromEntries(ef.map((x,i)=>[x,i]));
  if(nodes.length%ns||edges.length%es)throw new Error('invalid_heap_layout_offsets');
  const starts=new Uint32Array(nodes.length/ns+1);let edgeOffset=0;
  for(let index=0;index<nodes.length/ns;index++){starts[index]=edgeOffset;edgeOffset+=nodes[index*ns+ni.edge_count]*es;}
  starts[starts.length-1]=edgeOffset;if(edgeOffset!==edges.length)throw new Error('invalid_heap_layout_edge_count');
  const edgeType=offset=>meta.edge_types[ei.type][edges[offset+ei.type]],nodeType=offset=>meta.node_types[ni.type][nodes[offset+ni.type]];
  const childEdges=offset=>{if(!Number.isInteger(offset)||offset<0||offset%ns||offset>=nodes.length)throw new Error('invalid_heap_layout_target');return [starts[offset/ns],starts[offset/ns+1]];};
  const targets=(offset,type,name)=>{const [start,end]=childEdges(offset),found=[];for(let i=start;i<end;i+=es)if(edgeType(i)===type&&(name===undefined||strings[edges[i+ei.name_or_index]]===name))found.push(edges[i+ei.to_node]);return found;};
  const roots=[];
  for(let i=0;i<edges.length;i+=es)if(edgeType(i)==='property'&&strings[edges[i+ei.name_or_index]]==='__ri00LayoutSelectedSamples')roots.push(edges[i+ei.to_node]);
  if(roots.length!==1)throw new Error('unique_heap_layout_root_required');
  const detail=offset=>({type:nodeType(offset),selfBytes:nodes[offset+ni.self_size]});
  const fields=['evidenceRef','createdAt','planId','conversationId','streamId','toolCallId','capabilityId','toolName','artifactRefs','userArtifacts','bodyPreview'];
  const describe=offset=>{
    const value={...detail(offset),properties:targets(offset,'internal','properties').map(detail),fields:{}};
    for(const name of fields){const found=targets(offset,'property',name);if(found.length>1)throw new Error('ambiguous_layout_field');if(found.length)value.fields[name]=detail(found[0]);}
    return value;
  };
  const samples=targets(roots[0],'element').map(offset=>{
    const raw=targets(offset,'property','raw'),output=targets(offset,'property','output');
    if(raw.length!==1||output.length!==1)throw new Error('layout_sample_missing');return {raw:describe(raw[0]),output:describe(output[0])};
  });
  if(samples.length!==64)throw new Error('layout_sample_count_changed');
  return {kind:'post_gc_sample_self_sizes-not-total-retained-size',samples};
}
