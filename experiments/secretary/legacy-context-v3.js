// Frozen v3 material selection, from ba6a89f; neighboringRecords is unchanged.
export function legacyMaterial(records, options) {
    const context = this.neighboringRecords(records, options);
    return [...context,...records].sort((a,b)=>a.seq-b.seq).map(r=>{
      const e=this.evidence(r,0,records.includes(r)?Math.min(6000,Math.floor(18000/records.length)):1200);
      return {id:e.id,speaker:e.senderName || e.sender,speakerId:e.sender,department:e.department,
        time:e.platformAt || e.receivedAt,timeKind:e.platformAt?'平台消息时间':'接收时间',
        text:e.text,truncated:e.nextOffset!==null,contextOnly:!records.includes(r)};
    });
}
