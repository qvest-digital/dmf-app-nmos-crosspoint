



export function getSearchTokens(search:string){
    let parts = search.split("||");
    let tokens:string[][] = [];
    parts.forEach((p)=>{
        let combT = p.split("&&")
        let comb:string[] = []
        combT.forEach((c)=>{
            if(c != ""){
                comb.push(c.trim())
            }
        })
        if(comb.length != 0){
            tokens.push(comb);
        }
    })

    return tokens;
}


export function tokenSearch(input:string|any, tokens:string[][], keys:string[]|null = null){
    if(tokens.length == 0){
        return true;
    }
    if(keys){
        
    }else{
        input = { "text" : input };
        keys = ["text"];
    }

    let found = false;
    
    

    tokens.forEach((token:string[])=>{
        let combFound = true;
        token.forEach((comb)=>{
            let keyFound = false;
            keys.forEach((k)=>{
                // Fields can legitimately be missing (e.g. a flow without an
                // alias) — the old unguarded .search() threw, the caller's
                // try/catch swallowed it and the whole filter pass silently
                // aborted.
                let v = input[k];
                if(typeof v === "string" && v.search(new RegExp(comb, "i")) != -1){
                    keyFound = true
                }
            });
            if(!keyFound){
                combFound = false;
            }
        });

        if(combFound){
            found = true;
        }
    });

    return found;
}

// ----- Transport family -----
// The same rule as server/src/lib/transport.ts: every RTP variant is one
// family, MXL another. The matrix offers a crosspoint only within a family;
// the server refuses the rest on its own.
export function transportFamily(transport:string|null|undefined):string{
    let t = ("" + (transport || "")).trim().toLowerCase();
    if(t.startsWith("urn:x-nmos:transport:")){ t = t.substring("urn:x-nmos:transport:".length); }
    if(t === "rtp" || t.startsWith("rtp.")) return "rtp";
    if(t === "mxl" || t === "websocket" || t === "mqtt") return t;
    return "";
}

/** Unknown on either side is not refused: there is nothing to compare. */
export function transportsCompatible(a:string|null|undefined, b:string|null|undefined):boolean{
    let fa = transportFamily(a), fb = transportFamily(b);
    if(fa === "" || fb === "") return true;
    return fa === fb;
}
