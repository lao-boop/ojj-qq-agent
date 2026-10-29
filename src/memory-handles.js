/** Per-request opaque handles avoid asking a model to transcribe long storage UUIDs. */
export function memoryRecordsForModel(records, handles) {
  return records.map(record=>{
    let handle=[...handles].find(([,id])=>id===record.id)?.[0];
    if(!handle){handle=`m${handles.size+1}`;handles.set(handle,record.id);}
    return {...record,id:handle};
  });
}
export function resolveMemoryId(ctx, handle) {
  if(!ctx.memoryHandles)return handle; // Non-model callers still use actual, scoped storage IDs.
  const id=ctx.memoryHandles.get(handle);
  if(!id)throw new Error('这不是本轮提供的记忆编号，请用 search_memory 核对后再操作，不会猜测修改对象');
  return id;
}
