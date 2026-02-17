export async function fetchWikipediaArticle(title, callback) {
   const url = new URL('https://en.wikipedia.org/w/api.php');
   url.searchParams.set('action', 'query');
   url.searchParams.set('format', 'json');
   url.searchParams.set('prop', 'extracts');
   url.searchParams.set('exintro', true); // Get only the introduction
   url.searchParams.set('explaintext', true); // Get plain text
   url.searchParams.set('titles', title);
   url.searchParams.set('origin', '*'); // Bypass CORS issues
   try {
      const response = await fetch(url.toString());
      if (! response.ok)
         throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      const pages = data.query.pages;
      const pageId = Object.keys(pages)[0];
      callback(pages[pageId].extract);
   } catch (error) { callback(null); }
}

export async function fetchWikipediaFullArticle(title, callback) {
   let url = `https://en.wikipedia.org/w/api.php?action=query&format=json\
&origin=*&titles=${encodeURIComponent(title)}&prop=extracts&explaintext`;
   try {
      let response = await fetch(url);
      if (! response.ok)
         throw new Error();
      let data = await response.json();
      let pages = data.query.pages;
      let pageId = Object.keys(pages)[0];
      let extract = pages[pageId].extract;
      callback(extract);
   } catch (error) { callback(null); }
}
