let particles = [];
let maxParticles = 100; 
let particleCursor = 0;

export const init = async model => {

    for (let i = 0; i < maxParticles; i++) {
        particles.push({
            obj: model.add('cube').scale(0), 
            pos: [0, 0, 0],
            vel: [0, 0, 0],
            life: 0,
            color: [1, 1, 0] 
        });
    }

    inputEvents.onPress = hand => {


        for (let i = 0; i < 80; i++) {
            let p = particles[particleCursor];
            
            p.pos = [0, 0, 0]; 
            p.life = 1.0; 

            p.vel = [
                (Math.random() - 0.5) * 0.15, // X
                Math.random() * 0.3 + 0.1,    // Y
                (Math.random() - 0.5) * 0.15  // Z
            ];

            p.color = [Math.random(), Math.random(), 1]; 

            particleCursor = (particleCursor + 1) % maxParticles;
        }
    };

    model.move(0, .05, -.6).scale(0.1).animate(() => {
        
        for (let p of particles) {
            if (p.life > 0) {

                p.pos[0] += p.vel[0];
                p.pos[1] += p.vel[1];
                p.pos[2] += p.vel[2];

                p.vel[1] -= 0.005; 
                p.life -= 0.01;    

                p.obj.identity()
                    .move(p.pos[0], p.pos[1], p.pos[2])
                    .scale(p.life * 0.3) 
                    .color(p.color[0], p.color[1], p.color[2]); 
                    
            } else {
                p.obj.scale(0); 
            }
        }
    });
}