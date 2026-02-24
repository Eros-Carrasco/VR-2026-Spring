import * as cg from "../render/core/cg.js";
import { texts } from "../util/texts.js";
import { fetchWikipediaFullArticle } from "../fetchWikipediaArticle.js";

let ramp = (lo,hi,t) => Math.max(.001, Math.min(.999, (t-lo) / (hi-lo)));
let title = 'Stopping\nby Woods\non a\nSnowy\nEvening';

let poem = `\
Whose woods these are I think I know.
His house is in the village though;
He will not see me stopping here
To watch his woods fill up with snow.

My little horse must think it queer
To stop without a farmhouse near
Between the woods and frozen lake
The darkest evening of the year.

He gives his harness bells a shake
To ask if there is some mistake.
The only other sound's the sweep
Of easy wind and downy flake.

The woods are lovely, dark and deep,
But I have promises to keep,
And miles to go before I sleep,
And miles to go before I sleep.
`;

let analysis = `\
"Stopping by Woods on a Snowy Evening" is a poem by Robert Frost, written in 1922, and published in 1923 in his New Hampshire volume. Imagery, personification, and repetition are prominent in the work. In a letter to Louis Untermeyer, Frost called it "my best bid for remembrance".

Background

Frost wrote the poem in June 1922 at his house in Shaftsbury, Vermont. He had been up the entire night writing the long poem "New Hampshire" from the poetry collection of the same name, and had finally finished when he realized morning had come. He went out to view the sunrise and suddenly got the idea for "Stopping by Woods on a Snowy Evening". He wrote the new poem "about the snowy evening and the little horse as if I'd had a hallucination" in just "a few minutes without strain."

Analysis

The text of the poem reflects the thoughts of a lone wagon driver (the narrator), on the night of the winter solstice, "the darkest evening of the year", pausing at dusk in his travel to watch snow falling in the woods. It ends with him reminding himself that, despite the loveliness of the view, "I have promises to keep, / And miles to go before I sleep."

Structure and style

The poem is written in iambic tetrameter in the Rubaiyat stanza created by Edward FitzGerald, who adopted the style from Hakim Omar Khayyam, the 12th-century Persian poet and mathematician. Each verse (save the last) follows an AABA rhyming scheme, with the following verse's A line rhyming with that verse's B line, which is a chain rhyme (another example is the terza rima used in Dante's Inferno). Overall, the rhyme scheme is AABA BBCB CCDC DDDD.
The poem begins with a moment of quiet introspection, which is reflected in the soft sounds of w's and th's, as well as double ll's. In the second stanza, harder sounds - like k and qu - begin to break the whisper. As the narrator's thought is disrupted by the horse in the third stanza, a hard g is used.

Adaptations

The poem was set to music by Randall Thompson as part of Frostiana.
The American composer Eric Whitacre first set this poem to music in 2000; due to a legal dispute with the Frost estate over the use of the poem, he engaged his friend, poet Charles Silvestri, to write alternative lyrics. The result was Sleep, one of their most celebrated collaborations. In January 2019 the Frost poem entered the public domain, finally allowing Whitacre to perform the piece as it was originally composed.
`;

function LayeredText() {
   const x = -.115, y = .12;
   let objs = [];
   this.add = (obj, A, B, C) => {
      obj.add(clay.text(A)).move(x+.01,y+.01,   0).scale(2.00);
      obj.add(clay.text(B)).move(x    ,y    ,.005).scale(0.50);
      obj.add(clay.text(C)).move(x    ,y    ,.010).scale(0.22);
      objs.push(obj);
   }
   this.view = () => {
      let mm = cg.mMultiply(clay.root().viewMatrix(0), worldCoords);
      for (let n = 0 ; n < objs.length ; n++) {
         let obj = objs[n];
         let m = cg.mMultiply(mm, obj.getMatrix());
         let p = m.slice(12,15);
         let d = cg.norm(p);
         let t = ramp(0.9, 1.0, d);
         let u = ramp(0.4, 0.5, d);
         obj.child(0).opacity(t);
         obj.child(1).opacity((1-t)*u);
         obj.child(2).opacity(1-u);
      }
   }
}

export const init = async model => {
   let A = title;
   let B = poem;
   let C = cg.split(analysis, 85);

   let layeredText = new LayeredText();
   for (let set = 0 ; set < 2 ; set++)
   for (let dir = 0 ; dir < 4 ; dir++)
   for (let col = 0 ; col < (set==0 ? 15 : 10) ; col++)
      layeredText.add(model.add().color(1,1,1)
                           .turnY(dir * Math.PI/2 + Math.PI)
                           .move([ .39 * (col - (set==0 ? 7 : 4.5)),
		                   1.5,
		                   set==0 ? -3 : -2 ]), A,B,C);

   model.animate(() => {
      layeredText.view();
   });
}

