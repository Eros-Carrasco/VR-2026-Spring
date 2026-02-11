export async function readFile(file, callback) {
   try {
      const response = await fetch(file);
      if (! response.ok)
         throw new Error(`HTTP error! status: ${response.status}`);
      callback(await response.text());
  } catch (error) { }
}           

export async function writeFile(file, text) {
   try {
      const handle = await showSaveFilePicker({ suggestedName: file });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
   } catch (err) {
      if (err.name !== 'AbortError')
         console.error('Error saving file:', err);
   }
}
