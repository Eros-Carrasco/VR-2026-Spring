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

export let parseArticle = (text, name) => {
   let removeLeadingBlankLines = text => {
      while (text.charAt(0) == '\n')
         text = text.substring(1);
      return text;
   }

   let flatArray = [];                           // FIRST CONVERT TEXT INTO A FLAT ARRAY OF NODES.
   let lines = text.replace(/–/g,'-')
                   .replace(/’/g,"'").split('\n');
   for (let n = 0 ; n < lines.length ; n++) {
      let line = lines[n];
      if (line.indexOf('==') == 0) {
         let level = line.indexOf('======') == 0 ? 5 :
                     line.indexOf('=====' ) == 0 ? 4 :
                     line.indexOf('===='  ) == 0 ? 3 :
                     line.indexOf('==='   ) == 0 ? 2 :
                                                   1 ;
         line = line.substring(0,line.length - level-2).substring(level+2,line.length);
         flatArray.push( { section: line, level: level });
      }
      else {
         let node = flatArray[flatArray.length-1];
         if (! node || node.data === undefined)
            flatArray.push(node = { data: '' });
         node.data += '\n' + line;
      }
   }

   let array = [], level = 1;                    // THEN CONVERT THE FLAT ARRAY TO NESTED ARRAYS OF NODES.
   for (let n = 0 ; n < flatArray.length ; n++)
      if (flatArray[n].section) {
         while (flatArray[n].level > level) {
            let parent = array;
            parent.push(array = []);
            array.parent = parent;
            level++;
         }
         while (flatArray[n].level < level) {
            let parent = array.parent;
            delete array.parent;
            array = parent;
            level--;
         }
         array.push(flatArray[n].section);
      }
      else
         array.push(flatArray[n].data)

   let rootnode = { text: array[0] };            // THEN CONVERT THE NESTED ARRAYS TO A NODE HIERARCHY.
   let parseArray = (array, n, rootnode) => {
      while (n < array.length) {
         let node = { };
         if (! rootnode.sections)
            rootnode.sections = [];
         rootnode.sections.push(node);
         node.name = array[n++];
         node.text = removeLeadingBlankLines(array[n++]);
         if (Array.isArray(array[n]))
            parseArray(array[n++], 0, node);
      }
   }
   parseArray(array, 1, rootnode);

   if (name)
      rootnode.name = name.replace(/_/g, ' ');

   return rootnode;                              // RETURN THE NODE HIERARCHY.
}

