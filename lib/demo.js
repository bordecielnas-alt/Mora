// Contenus d'exemple, utilisés seulement tant qu'aucune clé API n'est configurée.
// Ils sont inventés : « Ouvrir » lance une recherche web sur le titre.
const q = (t) => "https://duckduckgo.com/?q=" + encodeURIComponent(t);
const RAW = [
  ["article", "Design", "Smashing Magazine", "9 min", "Concevoir des interfaces calmes : moins de notifications, plus d’attention", "Une équipe raconte comment elle a supprimé 70 % des alertes de son app sans perdre d’utilisateurs actifs."],
  ["video", "Science", "YouTube · Science Étonnante", "18:42", "Pourquoi le ciel est-il bleu, mais pas violet ?", "Diffusion de Rayleigh, sensibilité de l’œil et un peu d’histoire de la physique."],
  ["podcast", "IA", "France Culture", "58 min", "Les modèles de langage comprennent-ils ce qu’ils disent ?", "Deux chercheuses débattent de ce que « comprendre » veut dire pour une machine."],
  ["lien", "Cuisine", "seriouseats.com", "Recette", "La méthode du riz croustillant à la poêle, pas à pas", "Un fond de poêle doré sans brûler, avec les températures exactes."],
  ["article", "Vélo", "Bike Radar", "7 min", "Gravel : comment choisir la largeur de ses pneus", "De 38 à 50 mm, ce que change chaque millimètre sur chemin et sur route."],
  ["video", "Musique", "YouTube · Adam Neely", "22:10", "La note qui rend une chanson nostalgique", "Analyse d’accords empruntés dans la pop des années 80 à aujourd’hui."],
  ["article", "IA", "The Gradient", "14 min", "Ce que les petits modèles font mieux que les grands", "Latence, coût, vie privée : un tour des cas où un modèle local gagne."],
  ["podcast", "Design", "Design Details", "47 min", "Typographie variable : un an après la migration", "Retour d’expérience d’une équipe produit sur les polices variables en production."],
  ["lien", "Science", "quantamagazine.org", "12 min", "Une nouvelle forme de glace découverte en laboratoire", "Plus dense que l’eau liquide et stable à température ambiante sous pression."],
  ["video", "Cuisine", "YouTube · Chef Chu", "11:05", "Le wok à la maison sans feu de restaurant", "Comment approcher le « souffle du wok » sur une plaque à induction."],
  ["article", "Musique", "Pitchfork", "6 min", "Le retour des albums écoutés en entier", "Les chiffres de streaming montrent un regain d’écoute d’albums complets chez les 20-30 ans."],
  ["podcast", "Vélo", "The Cycling Podcast", "64 min", "Traverser les Alpes en autonomie : le carnet de route", "Itinéraire, matériel et erreurs à éviter, racontés par trois cyclistes."],
  ["lien", "IA", "github.com", "Outil", "Un outil open source pour résumer ses favoris chaque semaine", "Se branche sur un export de navigateur et envoie un digest par e-mail."],
  ["article", "Science", "Le Monde", "8 min", "Les forêts urbaines rafraîchissent-elles vraiment les villes ?", "Mesures de terrain à Paris, Lyon et Montréal pendant les vagues de chaleur."],
  ["video", "Design", "YouTube · Figma", "31:20", "Prototyper des gestes crédibles", "Ressorts, seuils et retours haptiques pour que le geste paraisse naturel."],
  ["short", "Science", "YouTube · Science Étonnante", "48 s", "Le paradoxe des jumeaux en moins d’une minute", "Une animation qui rend la dilatation du temps évidente."],
  ["short", "Cuisine", "TikTok · Chef Chu", "35 s", "Le geste pour émincer un oignon sans pleurer", "Couteau, angle et rythme : la démonstration au ralenti."],
  ["podcast", "Cuisine", "On va déguster", "52 min", "Le pain au levain, de la farine au four", "Un boulanger et une meunière expliquent la fermentation longue."],
];
export const DEMO_THEMES = ["Design", "IA", "Cuisine", "Science", "Vélo", "Musique"];
export const demoItems = () =>
  RAW.map(([type, theme, source, duration, title, excerpt]) => ({
    type, theme, source, duration, title, excerpt, url: q(title), demo: true, language: "fr",
    why: "Exemple de démonstration",
  }));
