const DATABASE_NAME = "hcm-face-kiosk";
const DATABASE_VERSION = 1;
const TEMPLATE_STORE = "templates";
export const FACE_MATCH_THRESHOLD = 0.48;

let databasePromise;
let modelsPromise;

function openFaceDatabase() {
  if (!("indexedDB" in globalThis)) {
    return Promise.reject(new Error("This browser does not support local face-template storage."));
  }
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(TEMPLATE_STORE)) {
          request.result.createObjectStore(TEMPLATE_STORE, { keyPath: "userId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open local face-template storage."));
      request.onblocked = () => reject(new Error("Close other HCM kiosk tabs to update local face-template storage."));
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

function runTemplateTransaction(mode, operation) {
  return openFaceDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(TEMPLATE_STORE, mode);
    const request = operation(transaction.objectStore(TEMPLATE_STORE));
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error("Could not access the local face template."));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error("Could not save the local face template."));
    transaction.onabort = () => reject(transaction.error || new Error("Local face-template storage was interrupted."));
  }));
}

export function averageFaceDescriptors(samples) {
  if (!Array.isArray(samples) || samples.length < 3) {
    throw new Error("Capture three clear face samples before enrolling.");
  }
  const length = samples[0]?.length;
  if (!length || samples.some((sample) => sample.length !== length
    || Array.from(sample).some((value) => !Number.isFinite(value)))) {
    throw new Error("The face samples are invalid. Please capture them again.");
  }
  return Array.from({ length }, (_, index) => samples.reduce((sum, sample) => sum + sample[index], 0) / samples.length);
}

export function faceDescriptorDistance(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length || !first.length) {
    throw new Error("The stored face template is invalid. Enroll this kiosk again.");
  }
  let squaredDistance = 0;
  for (let index = 0; index < first.length; index += 1) {
    const difference = first[index] - second[index];
    squaredDistance += difference * difference;
  }
  return Math.sqrt(squaredDistance);
}

export function saveFaceTemplate(userId, descriptor) {
  if (!userId || !Array.isArray(descriptor) || descriptor.length !== 128
    || descriptor.some((value) => !Number.isFinite(value))) {
    return Promise.reject(new Error("Could not save an invalid face template."));
  }
  return runTemplateTransaction("readwrite", (store) => store.put({
    userId,
    descriptor,
    consentedAt: new Date().toISOString(),
    enrolledAt: new Date().toISOString(),
  }));
}

export function getFaceTemplate(userId) {
  return runTemplateTransaction("readonly", (store) => store.get(userId));
}

export function deleteFaceTemplate(userId) {
  return runTemplateTransaction("readwrite", (store) => store.delete(userId));
}

export async function loadFaceRecognitionModels() {
  if (!modelsPromise) {
    modelsPromise = import("@vladmandic/face-api").then(async (faceapi) => {
      const modelBase = `${import.meta.env.BASE_URL}models`;
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(modelBase),
        faceapi.nets.faceLandmark68Net.loadFromUri(modelBase),
        faceapi.nets.faceRecognitionNet.loadFromUri(modelBase),
      ]);
      return faceapi;
    }).catch((error) => {
      modelsPromise = null;
      throw new Error(`Face matching could not start. Refresh the kiosk and try again. ${error.message}`);
    });
  }
  return modelsPromise;
}
