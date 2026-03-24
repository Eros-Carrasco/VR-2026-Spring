import { split } from "../render/core/cg.js";
import { fetchWikipediaArticle } from "../fetchWikipediaArticle.js";
import { AIQuery } from "../util/aiquery.js";

/*
text6WithAI demo
----------------
Goal:
- Start from the same Wikipedia intro flow used by text6.js.
- Display the article text in the scene.
- Let the user ask questions from browser console about that exact text.
- Render AI answers back into the scene below the article.

How to use in browser console:
1) Direct question:
      await askText6AI("What does this article say?")
2) Variable + send helper:
      text6WithAIQuestion = "Summarize this article in 2 sentences.";
      await sendText6WithAIQuestion();

Requirements:
- /api/aiquery must be available on the running server.
- OPENAI_API_KEY must be set in .env for server/main.js.
   If .env does not exist yet, from project root run:
      cat > .env << 'EOF'
      OPENAI_API_KEY=your_key
      EOF
   If .env already exists, append key with:
      echo 'OPENAI_API_KEY=your_key' >> .env
*/

export const init = async model => {
   // Same source article as text6.js so this demo feels familiar.
   const articleTitle = "Virtual_reality";

   // Thin client wrapper around the server endpoint /api/aiquery.
   const aiQuery = new AIQuery();

   // Clamp prompt context and rendered answer length to keep scene readable.
   const contextLimit = 3500;
   const answerLimit = 1200;

   // Store fetched article so questions are grounded in visible content.
   let articleText = "";

   // Two separate roots:
   // - articleRoot: static loaded Wikipedia text
   // - answerRoot : dynamic AI response area
   const articleRoot = model.add().move(-0.36, 1.8, 0).color(1, 1, 1);
   const answerRoot = model.add().move(-0.36, 1.02, 0).color(0.7, 1, 0.9);

   // Rebuild article text geometry each time we update its content.
   // We clear children then add one clay.text node with wrapped lines.
   const setArticleText = text => {
      while (articleRoot.nChildren()) {
         articleRoot.remove(0);
      }
      articleRoot.add(clay.text(split(text, 60)));
   };

   // Rebuild answer text area (same approach as setArticleText).
   const setAnswerText = text => {
      while (answerRoot.nChildren()) {
         answerRoot.remove(0);
      }
      answerRoot.add(clay.text(split(text, 60)));
   };

   // Load Wikipedia intro text on scene start.
   // If load succeeds, render the article and usage hint.
   fetchWikipediaArticle(articleTitle, text => {
      articleText = text || "";
      if (!articleText) {
         setArticleText("Failed to load Wikipedia text.");
         return;
      }

      setArticleText(articleText);
      setAnswerText('Ask about this text in browser console:\naskText6AI("your question")');
   });

   // Main console API for this scene.
   // This function builds a grounded prompt from the visible article text,
   // sends it to AI, and renders the answer back into answerRoot.
   window.askText6AI = async question => {
      const q = (question || "").toString().trim();
      if (!q) {
         console.error('Usage: askText6AI("your question")');
         return "";
      }
      // Prevent sending empty context before async article fetch completes.
      if (!articleText) {
         console.error("Article text is not loaded yet.");
         return "";
      }

      // Immediate user feedback in-scene while waiting for network response.
      setAnswerText(`Q: ${q}\n\nThinking...`);

      // Context clipping keeps requests stable and prevents huge prompt payloads.
      const context = articleText.substring(0, contextLimit);

      // Grounded prompt policy:
      // - Ask model to use only provided article excerpt
      // - Ask model to say it cannot find answer when excerpt is insufficient
      const prompt =
         `Use ONLY the article context below to answer the question.\n` +
         `If answer is not in the context, say "I cannot find that in this article excerpt."\n\n` +
         `Article title: ${articleTitle.replace(/_/g, " ")}\n` +
         `Article excerpt:\n${context}\n\n` +
         `Question: ${q}`;

      try {
         // Call server-backed OpenAI query.
         const response = await aiQuery.askAI(prompt);

         // Render clipped answer in scene to avoid overly long geometry.
         const trimmed = (response || "").substring(0, answerLimit);
         setAnswerText(`Q: ${q}\n\nA: ${trimmed}`);
         console.log("[text6WithAI] Answer:", response);
         return response;
      } catch (error) {
         // Keep errors visible in-scene and console for debugging.
         const msg = `Error: ${error.message}`;
         setAnswerText(`Q: ${q}\n\n${msg}`);
         console.error("[text6WithAI] Error:", error.message);
         return msg;
      }
   };

   // Optional convenience globals:
   // set text6WithAIQuestion in console, then call sendText6WithAIQuestion().
   window.text6WithAIQuestion = "";
   window.sendText6WithAIQuestion = () => window.askText6AI(window.text6WithAIQuestion);

   console.log('[text6WithAI] Ready. Use askText6AI("your question") in browser console.');

   // Scene itself is static; updates happen only through async callbacks above.
   model.animate(() => {});
};
