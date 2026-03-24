"use strict";

const normalizePath = path => {
   if (!Array.isArray(path)) return [];
   return path.map(n => Number.isInteger(n) ? n : parseInt(n, 10)).filter(n => Number.isFinite(n) && n >= 0);
};

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

const getNodeByPath = (root, path) => {
   let node = root;
   const indices = normalizePath(path);
   for (const idx of indices) {
      if (!node || typeof node.nChildren !== "function" || typeof node.child !== "function") {
         return null;
      }
      if (idx < 0 || idx >= node.nChildren()) {
         return null;
      }
      node = node.child(idx);
   }
   return node;
};

const applyTransform = (node, transform = {}) => {
   if (!node) return;

   if (Array.isArray(transform.matrix) && transform.matrix.length === 16) {
      node.setMatrix(transform.matrix);
      return;
   }

   node.identity();
   if (Array.isArray(transform.position) && transform.position.length === 3) {
      node.move(transform.position[0], transform.position[1], transform.position[2]);
   }
   if (Array.isArray(transform.rotation) && transform.rotation.length === 3) {
      node.turnX(transform.rotation[0]);
      node.turnY(transform.rotation[1]);
      node.turnZ(transform.rotation[2]);
   }
   if (Array.isArray(transform.scale) && transform.scale.length === 3) {
      node.scale(transform.scale[0], transform.scale[1], transform.scale[2]);
   }
};

const summarizeNode = (node, index = null) => {
   if (!node) return null;
   const form = typeof node.getForm === "function" ? node.getForm() : null;
   return {
      index,
      form,
      aliases: form && formAliases[form] ? formAliases[form] : [],
      info: typeof node.getInfo === "function" ? node.getInfo() : null,
      nChildren: typeof node.nChildren === "function" ? node.nChildren() : 0,
      color: typeof node.get === "function" ? node.get("color") : null
   };
};

export const buildSceneTooling = (root) => {
   if (!root) {
      throw new Error("Scene root is required to build scene tooling");
   }

   const tools = [
      {
         type: "function",
         function: {
            name: "scene_list_children",
            description: "List direct children for a node at a given path from the scene root.",
            parameters: {
               type: "object",
               properties: {
                  path: {
                     type: "array",
                     items: { type: "integer" },
                     description: "Path of child indices from the scene root. Omit for root."
                  }
               },
               required: []
            }
         }
      },
      {
         type: "function",
         function: {
            name: "scene_get_node",
            description: "Get details about a node (form, info, children count, matrix, color).",
            parameters: {
               type: "object",
               properties: {
                  path: {
                     type: "array",
                     items: { type: "integer" },
                     description: "Path of child indices from the scene root."
                  }
               },
               required: ["path"]
            }
         }
      },
      {
         type: "function",
         function: {
            name: "scene_add_primitive",
            description: "Add a primitive child to the node at path and optionally set transform/color/info.",
            parameters: {
               type: "object",
               properties: {
                  path: {
                     type: "array",
                     items: { type: "integer" },
                     description: "Parent path. Omit for root."
                  },
                  form: {
                     type: "string",
                     description: "Primitive form name (e.g., cube, sphere, tubeZ, square, text)."
                  },
                  transform: {
                     type: "object",
                     properties: {
                        position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                        rotation: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                        scale: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                        matrix: { type: "array", items: { type: "number" }, minItems: 16, maxItems: 16 }
                     },
                     required: []
                  },
                  color: {
                     type: "array",
                     items: { type: "number" },
                     minItems: 3,
                     maxItems: 3
                  },
                  info: { type: "string" }
               },
               required: ["form"]
            }
         }
      },
      {
         type: "function",
         function: {
            name: "scene_set_transform",
            description: "Set a node's transform (position/rotation/scale or matrix).",
            parameters: {
               type: "object",
               properties: {
                  path: { type: "array", items: { type: "integer" } },
                  transform: {
                     type: "object",
                     properties: {
                        position: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                        rotation: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                        scale: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
                        matrix: { type: "array", items: { type: "number" }, minItems: 16, maxItems: 16 }
                     },
                     required: []
                  }
               },
               required: ["path", "transform"]
            }
         }
      },
      {
         type: "function",
         function: {
            name: "scene_set_color",
            description: "Set a node's RGB color.",
            parameters: {
               type: "object",
               properties: {
                  path: { type: "array", items: { type: "integer" } },
                  color: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 }
               },
               required: ["path", "color"]
            }
         }
      },
      {
         type: "function",
         function: {
            name: "scene_remove_node",
            description: "Remove a node at path.",
            parameters: {
               type: "object",
               properties: {
                  path: { type: "array", items: { type: "integer" } }
               },
               required: ["path"]
            }
         }
      }
   ];

   const handlers = {
      scene_list_children: ({ path }) => {
         const node = getNodeByPath(root, path || []);
         if (!node) return { error: "Invalid path" };
         const children = [];
         for (let i = 0; i < node.nChildren(); i++) {
            children.push(summarizeNode(node.child(i), i));
         }
         return { path: normalizePath(path), count: children.length, children };
      },

      scene_get_node: ({ path }) => {
         const node = getNodeByPath(root, path);
         if (!node) return { error: "Invalid path" };
         const form = typeof node.getForm === "function" ? node.getForm() : null;
         return {
            path: normalizePath(path),
            form,
            aliases: form && formAliases[form] ? formAliases[form] : [],
            info: typeof node.getInfo === "function" ? node.getInfo() : null,
            nChildren: typeof node.nChildren === "function" ? node.nChildren() : 0,
            color: typeof node.get === "function" ? node.get("color") : null,
            opacity: typeof node.get === "function" ? node.get("opacity") : null,
            matrix: typeof node.getMatrix === "function" ? node.getMatrix().slice() : null
         };
      },

      scene_add_primitive: ({ path, form, transform, color, info }) => {
         const parent = getNodeByPath(root, path || []);
         if (!parent) return { error: "Invalid parent path" };
         if (!form || typeof parent.add !== "function") return { error: "Invalid form or parent" };

         const child = parent.add(form);
         if (transform) applyTransform(child, transform);
         if (Array.isArray(color) && color.length === 3 && typeof child.color === "function") {
            child.color(color[0], color[1], color[2]);
         }
         if (typeof info === "string" && typeof child.info === "function") {
            child.info(info);
         }

         const index = parent.nChildren() - 1;
         const newPath = normalizePath(path).concat([index]);
         return { path: newPath, index, form };
      },

      scene_set_transform: ({ path, transform }) => {
         const node = getNodeByPath(root, path);
         if (!node) return { error: "Invalid path" };
         applyTransform(node, transform || {});
         return { ok: true, path: normalizePath(path) };
      },

      scene_set_color: ({ path, color }) => {
         const node = getNodeByPath(root, path);
         if (!node) return { error: "Invalid path" };
         if (!Array.isArray(color) || color.length !== 3 || typeof node.color !== "function") {
            return { error: "Invalid color or node" };
         }
         node.color(color[0], color[1], color[2]);
         return { ok: true, path: normalizePath(path), color };
      },

      scene_remove_node: ({ path }) => {
         const indices = normalizePath(path);
         if (indices.length === 0) return { error: "Cannot remove the root" };
         const parentPath = indices.slice(0, -1);
         const index = indices[indices.length - 1];
         const parent = getNodeByPath(root, parentPath);
         if (!parent) return { error: "Invalid parent path" };
         if (index < 0 || index >= parent.nChildren()) return { error: "Invalid child index" };
         parent.remove(index);
         return { ok: true, path: indices };
      }
   };

   const systemPrompt =
      "You are a WebXR scene operator. Use tools to inspect and modify the scene. " +
      "Do not assume scene structure. Prefer listing children before acting. " +
      "When modifying, make minimal, reversible changes and report what you changed. " +
      "Alias mapping: cylinder -> tubeY (vertical), horizontal cylinder -> tubeX or tubeZ; " +
      "box -> cube; ball -> sphere; cone -> coneY; pyramid -> pyramidY. " +
      "If the user mentions an alias, refer to the underlying form in your answer.";

   return { tools, handlers, systemPrompt };
};
