import { EventBus } from "/js/primitive/eventbus.js";

const FC_queryParams = new Proxy(new URLSearchParams(window.location.search), {
  get: (searchParams, prop) => searchParams.get(prop),
});

const PRESENTATION_FLAG_DEFAULT    = 0;
window.PRESENTATION_FLAG_DEFAULT   = PRESENTATION_FLAG_DEFAULT;
const PRESENTATION_FLAG_NO_RENDER  = 1 << 0;
window.PRESENTATION_FLAG_NO_RENDER = PRESENTATION_FLAG_NO_RENDER;

window.server = new Server(2024);

window.presentationMode = PRESENTATION_FLAG_DEFAULT
//PRESENTATION_FLAG_NO_RENDER
;

window.openAIOutgoingMessage = "";
window.openAIIncomingMessage = "";
window.openAILastError = "";

window.sendOpenAIMessage = async (message = window.openAIOutgoingMessage) => {
   const prompt = (message || "").toString().trim();
   if (!prompt) {
      console.error("[OpenAI] Provide a message first (window.openAIOutgoingMessage).");
      return null;
   }

   window.openAIOutgoingMessage = prompt;
   window.openAILastError = "";
   console.log("[OpenAI] Sending:", window.openAIOutgoingMessage);

   try {
      const res = await fetch("/api/aiquery", {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({
            query: window.openAIOutgoingMessage,
            queryId: "console-test",
         }),
      });
      const data = await res.json();
      if (!res.ok) {
         throw new Error(data.details || data.error || `HTTP ${res.status}`);
      }

      window.openAIIncomingMessage = data.response || "";
      console.log("[OpenAI] Received:", window.openAIIncomingMessage);
      return window.openAIIncomingMessage;
   } catch (error) {
      window.openAILastError = error.message;
      console.error("[OpenAI] Request failed:", error.message);
      throw error;
   }
};

window.readOpenAIState = async () => {
   const res = await fetch("/api/aiquery/state");
   const state = await res.json();
   window.openAIOutgoingMessage = state.outgoingMessage || "";
   window.openAIIncomingMessage = state.incomingMessage || "";
   window.openAILastError = state.lastError || "";
   console.log("[OpenAI] Server state:", state);
   return state;
};

console.log("[OpenAI] Console helpers ready: set window.openAIOutgoingMessage, then run await sendOpenAIMessage().");

function containsFlags(flags, checkFlags) {
   return (flags & checkFlags) == checkFlags;
}
window.containsFlags = containsFlags;

window.gpuUseAlphaToCoverage = true;

window.mainSubComm = null;
window.desktopHandtrackingEnabled = true;
window.desktopHandtrackingIsRemote = false;

window.shouldUseHandtracking = () => {
   return window.desktopHandtrackingEnabled && 
   !containsFlags(window.presentationMode, window.PRESENTATION_FLAG_NO_RENDER);
};

window.togglePresentationFlags = (flags) => {
   window.presentationMode ^= flags;
   window.clay.renderingIsActive = !containsFlags(window.presentationMode, window.PRESENTATION_FLAG_NO_RENDER);
};

{
   const textureCanvas = document.createElement('canvas');
   window.textureCanvas = textureCanvas;
   textureCanvas.id = "textureCanvas";
   textureCanvas.width = 1024;
   textureCanvas.height = 1024;
   textureCanvas.style.position = "absolute";
   textureCanvas.style.border = "0px solid";
   const textureCanvasContext2D = textureCanvas.getContext('2d');
   window.textureCanvasContext2D = textureCanvasContext2D;
}

window.EventBus = new EventBus();

async function main() {
    import("/js/corelink_handler.js").then(async (mod) => {
         await mod.run();
      });
   
}

async function mainSub() {
   const mod = await import('/js/render/core/videoHandTracker.js');
   mod.init(null, (handInfo_, fullResults_) => {
      window.sharedChan.postMessage(handInfo_);
   });      
}

if (!window.BroadcastChannel) {
   main();
} else {
   if (FC_queryParams['main']) {
      window.desktopHandtrackingIsRemote = true;
      window.desktopHandtrackingIsSent   = false;

      main();

      console.log("main w broadcast");
         window.sharedChan = new BroadcastChannel("FCchanHands");
         window.sharedChan.onmessage = event => { 
         // if (event.data == null || event.data == undefined || event.data.length == 0) {
         //    console.warn("nothing");
         // }
         window.handInfo = event.data;
         // console.log("received", handInfo);
      }

   } else if (FC_queryParams['sub']) {
      console.log("sub w broadcast");
      window.sharedChan = new BroadcastChannel("FCchanHands");
      // window.sharedChan.onmessage = event => { console.log(event); }

      window.desktopHandtrackingIsRemote = false;
      window.desktopHandtrackingIsSent   = true;

      mainSub();
   } else {
      main();
   }
}
