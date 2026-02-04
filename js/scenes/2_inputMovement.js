let scale = [.4, .4, .4];
let color = [.5, .5, .5];

let posL = [0, 0, 0];
let posR = [0, 0, 0];

export const init = async model => {
    let obj1 = model.add('cube');

    inputEvents.onMove = hand => {
        if (isXR()) {
            if (hand == 'left') {
                color[0] = inputEvents.pos(hand)[0] * .5 + .5;
                posL = inputEvents.pos(hand);
            }

            if (hand == 'right') {
                color[2] = inputEvents.pos(hand)[0] * .5 + .5;
                posR = inputEvents.pos(hand);
            }

            let dist = Math.abs(posR[0] - posL[0]);

            scale[0] = dist + .05;
            scale[1] = dist + .05;
            scale[2] = dist + .05; 
        }
    }

    

    model.move(0, 1.25, 0).scale(.1).animate(() => {
        obj1.identity().turnY(model.time).color(color).scale(scale[0], scale[1], scale[2]);
    });

}