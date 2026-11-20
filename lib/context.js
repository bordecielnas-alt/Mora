// Contexte de l'utilisateur en cours (multi-comptes) : chaque requête et chaque recherche
// tournent « dans » le contexte de leur compte, qui porte son stockage et sa connexion Claude.
import { AsyncLocalStorage } from "node:async_hooks";

export const als = new AsyncLocalStorage();
/** Le contexte du compte en cours, ou null (mode local, un seul utilisateur). */
export const current = () => als.getStore() || null;
