export const init = async model => { 
  const node0 = model.add('cube').color(0, 1, 0).identity().move(-0.4, 1.5, -2).scale(0.075, 0.15, 0.075);
  const node1 = model.add('tubeY').color(1, 0, 0).identity().move(-0.2, 1.5, -2).scale(0.1, 0.2, 0.1);
  const node2 = model.add('cube').color(0, 0, 1).identity().move(0, 1.5, -2).scale(0.075, 0.075, 0.075);
  const node3 = model.add('sphere').color(1, 0, 0).identity().move(0.2, 1.5, -2).scale(0.15, 0.15, 0.15);
  const node4 = model.add('cube').color(1, 0, 0).identity().move(0.4, 1.5, -2).scale(0.037895995281138004, 0.075, 0.053814438368398027);
};