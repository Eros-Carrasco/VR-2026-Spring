import { split } from "../render/core/cg.js";
import { AIQuery } from "../util/aiquery.js";
import { buildSceneTooling } from "../util/scene_tools.js";

/*
How to try this demo (end-to-end)
1) Make sure the server is running from project root:
      ./startserver
2) Make sure OpenAI key is available to server/main.js:
      .env contains OPENAI_API_KEY=your_key
   If .env does not exist yet, from project root run:
      cat > .env << 'EOF'
      OPENAI_API_KEY=your_key
      EOF
   If .env already exists, append key with:
      echo 'OPENAI_API_KEY=your_key' >> .env
3) Open the app in browser and switch to the "aiQuery" scene.
4) Open browser DevTools console and run one of:
      await askGeneralQuestions("What is WebXR?");
      await askSceneInspector("What's in the scene right now?");
      await askSceneCoder("Create a rotating red cube");
   or:
      generalQuestion = "Give me 3 ideas for a VR class demo.";
      await sendGeneralQuestion();
5) The answer is rendered back into the WebXR scene text panel.

What this scene exposes globally
- askGeneralQuestions(question: string): Promise<string>
  Sends one question to /api/aiquery and returns the answer string.
  Use this for general Q&A that does not need to inspect or change the scene.
- askSceneInspector(question: string): Promise<string>
  Uses tool-calling to inspect and modify the live scene under generatedRoot.
  Use this for questions like "what's in the scene?" or small edits like "move the cube up".
- askSceneCoder(prompt: string, filePath?: string): Promise<string>
  Asks the AI to generate full scene code, validates it, saves it to js/scenes/aiGenerated.js,
  and hot-loads it into the current scene. Use this when you want to rewrite the scene file.
- askEverything(...) is intentionally commented out below.
  It tries to auto-route between tools/code but is still unstable. Do not use it yet.
- generalQuestion: string
  Shared variable you can set from console.
- sendGeneralQuestion(): Promise<string>
  Convenience wrapper that calls askGeneralQuestions(generalQuestion).

Notices and limitations:
- No multi-turn memory: each call is stateless; the AI does not remember prior questions.
- askSceneCoder writes directly to `js/scenes/aiGenerated.js` (overwrites the file). Depending on the generation results, there are chances that the coder makes syntax errors.
- Generated results are best-effort and may be incorrect or incomplete.
*/

export const init = async model => {
   // Small helper class in js/util/aiquery.js that talks to /api/aiquery.
   const aiQuery = new AIQuery();

   // Guard against very long text exploding the panel layout.
   const maxChars = 2200;

   // Optional background panel behind text.
   // Keep opacity at 0 if you want transparent background.
   model.add("square").move(0, 1.58, -0.01).scale(0.72, 0.44, 1).color(0, 0, 0).opacity(0);

   // Text container node. We rebuild only this node's children on each update.
   const textRoot = model.add().move(-0.52, 1.92, 0).scale(0.55);
   const generatedRoot = model.add();

   // Rebuild panel text in-world.
   // We clear old text geometry and add a fresh clay.text(...) node each call.
   const renderPanel = (question, answer, status = "ready") => {
      while (textRoot.nChildren()) {
         textRoot.remove(0);
      }

      // Fallback content to keep panel readable before first query.
      const safeQuestion = question && question.trim() ? question.trim() : "(none)";
      const safeAnswer = answer && answer.trim() ? answer.trim() : "(none yet)";
      let panelText =
         "AI Query Demo\n" +
         "Type in browser console:\n" +
         // 'askEverything("your question")  // auto-routed by AI\n' +
         'askGeneralQuestions("any general question")\n' +
         'askSceneInspector("inspect the scene")\n\n' +
         'askSceneCoder("describe a scene for the AI to create")\n\n' +
         `Status: ${status}\n\n` +
         `Question:\n${safeQuestion}\n\n` +
         `Answer:\n${safeAnswer}`;

      // Hard cap for safety. Prevents huge responses from flooding geometry.
      if (panelText.length > maxChars) {
         panelText = panelText.substring(0, maxChars) + "\n...[truncated]";
      }

      // Same style as text scenes: split long text lines and render with clay.text.
      textRoot.add(clay.text(split(panelText, 62))).color(1, 1, 1);
   };

   // Keep latest values for panel refresh and debugging.
   let lastQuestion = "";
   let lastAnswer = "";

   // Main console API (general Q&A only, no scene access):
   // Example: await askGeneralQuestions("Explain spatial computing in one sentence.");
   window.askGeneralQuestions = async question => {
      const prompt = (question || "").toString().trim();
      if (!prompt) {
         console.error('Usage: askGeneralQuestions("your question")');
         return "";
      }

      // Immediately show progress in scene.
      lastQuestion = prompt;
      renderPanel(lastQuestion, "Thinking...", "sending");
      console.log(`[aiQuery scene] Sending (general): ${lastQuestion}`);

      try {
         // Send question to server route /api/aiquery (through AIQuery helper).
         const response = await aiQuery.askAI(lastQuestion);
         lastAnswer = response || "";

         // Render successful answer into the scene.
         renderPanel(lastQuestion, lastAnswer, "done");
         console.log("[aiQuery scene] Received (general):", lastAnswer);
         return lastAnswer;
      } catch (error) {
         // Render error text in scene so failure is visible in XR, not only console.
         lastAnswer = `Error: ${error.message}`;
         renderPanel(lastQuestion, lastAnswer, "error");
         console.error("[aiQuery scene] General error:", error.message);
         return lastAnswer;
      }
   };

   // Alternate console flow:
   // generalQuestion = "..."; await sendGeneralQuestion();
   window.generalQuestion = "";
   window.sendGeneralQuestion = () => window.askGeneralQuestions(window.generalQuestion);

   const clearNode = node => {
      while (node.nChildren()) node.remove(0);
   };

   const allowedForms = new Set([
      "coneX","coneY","coneZ","cube","cube,rounded","cubeXZ",
      "pyramidX","pyramidY","pyramidZ","ringX","ringY","ringZ",
      "sphere","square","octahedron","torusX","torusY","torusZ",
      "tubeX","tubeY","tubeZ","diskX","diskY","diskZ"
   ]);
   const formAliases = {
      tubeY: ["cylinder"],
      tubeX: ["cylinder", "horizontal cylinder"],
      tubeZ: ["cylinder", "horizontal cylinder"],
      sphere: ["ball"],
      cube: ["box"],
      cubeXZ: ["flat box", "platform"],
      diskX: ["flat disk"],
      diskY: ["disk"],
      diskZ: ["vertical disk"],
      coneY: ["cone"],
      pyramidY: ["pyramid"]
   };

   const summarizeScene = (root, maxNodes = 80) => {
      const summary = [];
      const walk = (node, path) => {
         if (!node || summary.length >= maxNodes) return;
         const form = typeof node.getForm === "function" ? node.getForm() : null;
         const entry = {
            path: path.slice(),
            form,
            aliases: form && formAliases[form] ? formAliases[form] : [],
            info: typeof node.getInfo === "function" ? node.getInfo() : null,
            color: typeof node.get === "function" ? node.get("color") : null,
            matrix: typeof node.getMatrix === "function" ? node.getMatrix().slice() : null
         };
         summary.push(entry);
         const count = typeof node.nChildren === "function" ? node.nChildren() : 0;
         for (let i = 0; i < count; i++) {
            walk(node.child(i), path.concat([i]));
            if (summary.length >= maxNodes) break;
         }
      };
      const count = typeof root.nChildren === "function" ? root.nChildren() : 0;
      for (let i = 0; i < count; i++) {
         walk(root.child(i), [i]);
         if (summary.length >= maxNodes) break;
      }
      return summary;
   };

   const loadGeneratedScene = async () => {
      try {
         clearNode(generatedRoot);
         // Clear any previous animation on this node.
         generatedRoot.animate(() => {});
         const mod = await import(`./aiGenerated.js?modid=${Date.now()}`);
         if (mod && typeof mod.init === "function") {
            await mod.init(generatedRoot);
            return { ok: true };
         }
         return { error: "aiGenerated.js has no init(model) export" };
      } catch (err) {
         return { error: err.message || String(err) };
      }
   };

   const saveSceneFile = async (path, contents) => {
      const response = await fetch('/api/saveScene', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ path, contents })
      });
      if (!response.ok) {
         const text = await response.text();
         throw new Error(`saveScene failed: ${response.status} ${text}`);
      }
      return response.json();
   };

   const formatNumber = n => {
      if (!Number.isFinite(n)) return "0";
      const rounded = Math.round(n * 1e6) / 1e6;
      return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
   };

   const formatArray = arr => "[" + arr.map(formatNumber).join(", ") + "]";

   const exportSceneToCode = root => {
      const lines = [];
      lines.push("/*");
      lines.push("   AI-generated scene. This file is overwritten by askSceneInspector/askSceneCoder.");
      lines.push("*/");
      lines.push("");
      lines.push("export const init = async model => {");

      let idCounter = 0;
      const emitNode = (node, parentVar, indent) => {
         const form = typeof node.getForm === "function" ? node.getForm() : null;
         const varName = `n${idCounter++}`;
         const addCall = form ? `${parentVar}.add('${form}')` : `${parentVar}.add()`;
         lines.push(`${" ".repeat(indent)}const ${varName} = ${addCall};`);

         if (typeof node.getMatrix === "function") {
            const m = Array.from(node.getMatrix());
            if (m && m.length === 16) {
               lines.push(`${" ".repeat(indent)}${varName}.setMatrix(${formatArray(m)});`);
            }
         }

         if (typeof node.get === "function") {
            const color = node.get("color");
            if (Array.isArray(color) && color.length === 3) {
               lines.push(
                  `${" ".repeat(indent)}${varName}.color(${formatNumber(color[0])}, ${formatNumber(color[1])}, ${formatNumber(color[2])});`
               );
            } else if (typeof color === "string") {
               lines.push(`${" ".repeat(indent)}${varName}.color(${JSON.stringify(color)});`);
            }

            const opacity = node.get("opacity");
            if (opacity !== undefined && opacity !== null && Number.isFinite(opacity) && opacity !== 1) {
               lines.push(`${" ".repeat(indent)}${varName}.opacity(${formatNumber(opacity)});`);
            }
         }

         if (typeof node.getInfo === "function") {
            const info = node.getInfo();
            if (typeof info === "string" && info.length) {
               lines.push(`${" ".repeat(indent)}${varName}.info(${JSON.stringify(info)});`);
            }
         }

         const count = typeof node.nChildren === "function" ? node.nChildren() : 0;
         for (let i = 0; i < count; i++) {
            emitNode(node.child(i), varName, indent);
         }
      };

      const count = typeof root.nChildren === "function" ? root.nChildren() : 0;
      for (let i = 0; i < count; i++) {
         emitNode(root.child(i), "model", 3);
      }

      lines.push("};");
      lines.push("");
      return lines.join("");
   };

   const extractCode = text => {
      if (!text) return "";
      let code = text.trim();
      const fenceStart = code.indexOf("```");
      if (fenceStart >= 0) {
         const after = code.indexOf("", fenceStart);
         const fenceEnd = code.indexOf("```", fenceStart + 3);
         if (after >= 0 && fenceEnd > after) {
            code = code.substring(after + 1, fenceEnd).trim();
         }
      }
      return code;
   };

   const validateSceneCode = code => {
      const errors = [];
      if (!code.includes("export const init = async model => {")) {
         errors.push("Missing required 'export const init = async model => {'");
      }
      if (!code.trim().endsWith("};")) {
         errors.push("Code must end with '};'");
      }

      const forbiddenTokens = [
         "matrix(",          // unsupported function
         "setMatrix(",       // disallow in generated code
         "txtr(", "txtrSrc(", "texture", // textures are disabled for now
         "import ", "require(", "document.", "window.", "eval("
      ];
      for (const token of forbiddenTokens) {
         if (code.includes(token)) {
            errors.push(`Forbidden token: ${token}`);
         }
      }

      const addRegex = /\.add\(\s*'([^']+)'\s*\)/g;
      let match;
      while ((match = addRegex.exec(code))) {
         const form = match[1];
         if (!allowedForms.has(form)) {
            errors.push(`Unsupported form '${form}' (see shapes.js list)`);
         }
      }

      // Basic syntax check (strip export to eval).
      try {
         const sanitized = code.replace("export const init", "const init");
         // eslint-disable-next-line no-new-func
         new Function(sanitized);
      } catch (err) {
         errors.push(`Syntax error: ${err.message}`);
      }

      return errors;
   };

   const sceneCodeSystemPrompt =
      "You are generating a WebXR scene using the Clay modeler API." +
      "Output ONLY JavaScript code (no markdown; no line breakers). Use the template:" +
      "export const init = async model => { /* create objects */ };" +
      "IMPORTANT: model is a sub-root. Do not call model.clear()." +
      "Create objects under this model only. Preserve existing objects unless the user asks to remove them." +
      "Allowed API (use ONLY these):" +
      "- model.add(form)" +
      "- model.animate(() => { ... })" +
      "- node.identity()" +
      "- node.move(x, y, z)" +
      "- node.turnX(theta), node.turnY(theta), node.turnZ(theta)" +
      "- node.scale(x, y, z)" +
      "- node.color(r, g, b)" +
      "- node.opacity(a)" +
      "Allowed forms (only these exact strings):" +
      "coneX, coneY, coneZ, cube, cube,rounded, cubeXZ, pyramidX, pyramidY, pyramidZ," +
      "ringX, ringY, ringZ, sphere, square, octahedron, torusX, torusY, torusZ," +
      "tubeX, tubeY, tubeZ, diskX, diskY, diskZ." +
      "Alias mapping (use these instead of inventing shapes):" +
      "- cylinder -> tubeY (vertical)" +
      "- horizontal cylinder -> tubeX or tubeZ" +
      "- box -> cube" +
      "- ball -> sphere" +
      "- cone -> coneY" +
      "- pyramid -> pyramidY" +
      "Do not use textures (no txtr/txtrSrc/texture)." +
      "Do not use matrix(...) or any unsupported functions." +
      "Prefer node.identity().move().turnX().turnY().turnZ().scale() for transforms." +
      "Place objects in front of the viewer (z around -2, y around 1.2 to 2.0)." +
      "For the scene coordinate system, +Y is up, +X is right, and -Z is forward." +
      "Do not import external libraries. Do not reference undefined variables.";

   // Code writer: generates full scene JS and saves it to disk.
   // Use when you want the result to persist as a file.
   window.askSceneCoder = async (question, filePath = "js/scenes/aiGenerated.js") => {
      const prompt = (question || "").toString().trim();
      if (!prompt) {
         console.error('Usage: askSceneCoder("describe the scene")');
         return "";
      }

      lastQuestion = prompt;
      renderPanel(lastQuestion, "Thinking (code)...", "sending");
      console.log(`[aiQuery scene] Sending (code): ${lastQuestion}`);

      try {
         const sceneSummary = summarizeScene(generatedRoot);
         const userContent =
            "User request: " + prompt + "" +
            "Current scene state (JSON array of nodes):" +
            JSON.stringify(sceneSummary) + "" +
            "Update the scene accordingly and output full code to recreate it.";

         const response = await aiQuery.askAI("", {
            messages: [
               { role: "system", content: sceneCodeSystemPrompt },
               { role: "user", content: userContent }
            ]
         });

         const code = extractCode(response);
         if (!code) {
            throw new Error("Empty code response");
         }
         const validationErrors = validateSceneCode(code);
         if (validationErrors.length) {
            throw new Error("Invalid code: " + validationErrors.join("; "));
         }

         await saveSceneFile(filePath, code);
         const loadResult = await loadGeneratedScene();
         if (loadResult && loadResult.error) {
            lastAnswer = `Saved to ${filePath}, but load failed: ${loadResult.error}`;
         } else {
            lastAnswer = `Saved and loaded ${filePath} into this scene.`;
         }
         renderPanel(lastQuestion, lastAnswer, "done");
         console.log("[aiQuery scene] Code saved:", filePath);
         return code;
      } catch (error) {
         lastAnswer = `Error: ${error.message}`;
         renderPanel(lastQuestion, lastAnswer, "error");
         console.error("[aiQuery scene] Code error:", error.message);
         return "";
      }
   };

   const safeParseJson = text => {
      if (!text) return null;
      try {
         return JSON.parse(text);
      } catch (_) {
         const start = text.indexOf("{");
         const end = text.lastIndexOf("}");
         if (start >= 0 && end > start) {
            try {
               return JSON.parse(text.substring(start, end + 1));
            } catch (err) {
               return null;
            }
         }
      }
      return null;
   };

   const routeSystemPrompt =
      "You are a router for a WebXR scene assistant. " +
      "Choose the correct mode for the user request. " +
      "Return JSON only with keys: mode, reason. " +
      "Valid modes: chat, tools, code. " +
      "Use 'tools' for questions about current scene contents. " +
      "Use 'code' when the user asks to generate or save a scene file. " +
      "Use 'chat' for general questions unrelated to scene editing.";

   const routeSceneRequest = async prompt => {
      const data = await aiQuery.queryFull("", {
         messages: [
            { role: "system", content: routeSystemPrompt },
            { role: "user", content: prompt }
         ],
         response_format: { type: "json_object" }
      });
      const content = (data.message && data.message.content) || data.response || "";
      const parsed = safeParseJson(content);
      if (parsed && typeof parsed.mode === "string") return parsed;
      return { mode: "tools", reason: "fallback" };
   };


   // window.askEverything = async question => {
   //    const prompt = (question || "").toString().trim();
   //    if (!prompt) {
   //       console.error('Usage: askEverything("your question")');
   //       return "";
   //    }
   //    let route;
   //    try {
   //       route = await routeSceneRequest(prompt);
   //    } catch (err) {
   //       route = { mode: "tools", reason: "router_error" };
   //    }
   //    if (route.mode === "code") {
   //       return window.askSceneCoder(prompt);
   //    }
   //    if (route.mode === "chat") {
   //       return window.askGeneralQuestions(prompt);
   //    }
   //    return window.askSceneInspector ? window.askSceneInspector(prompt) : window.askGeneralQuestions(prompt);
   // };

   // Tool-calling API for scene inspection and edits.
   // Use for incremental changes or questions about current objects.
   try {
      const tooling = buildSceneTooling(generatedRoot);
      const savePath = "js/scenes/aiGenerated.js";
      const mutatingTools = new Set([
         "scene_add_primitive",
         "scene_set_transform",
         "scene_set_color",
         "scene_remove_node"
      ]);
      const wrappedHandlers = {};
      for (const key of Object.keys(tooling.handlers)) {
         wrappedHandlers[key] = async args => {
            const result = await tooling.handlers[key](args);
            if (mutatingTools.has(key)) wrappedHandlers.__dirty = true;
            return result;
         };
      }

      window.askSceneInspector = async question => {
         const prompt = (question || "").toString().trim();
         if (!prompt) {
            console.error('Usage: askSceneInspector("your question")');
            return "";
         }

         lastQuestion = prompt;
         renderPanel(lastQuestion, "Thinking (tools)...", "sending");
         console.log(`[aiQuery scene] Sending (tools): ${lastQuestion}`);

         try {
            wrappedHandlers.__dirty = false;
            const response = await aiQuery.askAIWithTools(lastQuestion, tooling.tools, wrappedHandlers, {
               systemPrompt: tooling.systemPrompt,
               toolChoice: "auto",
               parallelToolCalls: false,
               maxSteps: 6
            });
            if (wrappedHandlers.__dirty) {
               const code = exportSceneToCode(generatedRoot);
               await saveSceneFile(savePath, code);
            }
            lastAnswer = response || "";
            renderPanel(lastQuestion, lastAnswer, "done");
            console.log("[aiQuery scene] Tools answer:", lastAnswer);
            return lastAnswer;
         } catch (error) {
            lastAnswer = `Error: ${error.message}`;
            renderPanel(lastQuestion, lastAnswer, "error");
            console.error("[aiQuery scene] Tools error:", error.message);
            return lastAnswer;
         }
      };
   } catch (err) {
      console.error("[aiQuery scene] Failed to init scene tooling:", err.message);
   }

   // Initial panel text so user sees instructions in-world immediately.
   renderPanel("", "", "ready");
   console.log('[aiQuery scene] Ready. Use askGeneralQuestions("your question") in browser console.');
   const loadResult = await loadGeneratedScene();
   if (loadResult && loadResult.error) {
      console.error("[aiQuery scene] Failed to load aiGenerated:", loadResult.error);
   }

   // Scene has no per-frame dynamic behavior right now.
   model.animate(() => {});
}
