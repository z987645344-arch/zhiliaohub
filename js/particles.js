(() => {
  const canvas = document.querySelector("#particle-canvas");
  const hero = document.querySelector(".hero");

  if (!canvas || !hero) return;

  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return;

  const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const frameInterval = 1000 / 45;
  const rainColor = "214, 222, 226";
  const fogColor = "202, 212, 218";
  let drops = [];
  let fogBanks = [];
  let width = 0;
  let height = 0;
  let deviceScale = 1;
  let animationFrame = 0;
  let lastFrameTime = 0;
  let renderedFrames = 0;
  let heroIsVisible = true;

  class RainDrop {
    constructor() {
      this.reset(true);
    }

    reset(initial = false) {
      this.x = Math.random() * (width + 120) - 60;
      this.y = initial ? Math.random() * height : -36 - Math.random() * 80;
      this.length = 10 + Math.random() * 24;
      this.speed = 2.2 + Math.random() * 3.6;
      this.wind = -0.2 - Math.random() * 0.42;
      this.alpha = 0.1 + Math.random() * 0.24;
      this.lineWidth = 0.45 + Math.random() * 0.55;
    }

    update() {
      this.x += this.wind;
      this.y += this.speed;

      if (this.y - this.length > height || this.x < -80) this.reset();
    }

    draw() {
      context.beginPath();
      context.moveTo(this.x, this.y);
      context.lineTo(this.x - this.wind * 3.6, this.y - this.length);
      context.strokeStyle = `rgba(${rainColor}, ${this.alpha})`;
      context.lineWidth = this.lineWidth;
      context.lineCap = "round";
      context.stroke();
    }
  }

  class FogBank {
    constructor(index) {
      this.index = index;
      this.reset(true);
    }

    reset(initial = false) {
      this.radius = Math.max(180, width * (0.2 + Math.random() * 0.18));
      this.x = initial ? Math.random() * width : -this.radius;
      this.y = height * (0.18 + Math.random() * 0.62);
      this.speed = 0.04 + Math.random() * 0.08;
      this.alpha = 0.024 + Math.random() * 0.034;
    }

    update() {
      this.x += this.speed;
      if (this.x - this.radius > width) this.reset();
    }

    draw() {
      const gradient = context.createRadialGradient(
        this.x,
        this.y,
        this.radius * 0.08,
        this.x,
        this.y,
        this.radius
      );
      gradient.addColorStop(0, `rgba(${fogColor}, ${this.alpha})`);
      gradient.addColorStop(0.56, `rgba(${fogColor}, ${this.alpha * 0.58})`);
      gradient.addColorStop(1, `rgba(${fogColor}, 0)`);
      context.fillStyle = gradient;
      context.fillRect(
        this.x - this.radius,
        this.y - this.radius,
        this.radius * 2,
        this.radius * 2
      );
    }
  }

  const createAtmosphere = () => {
    const area = width * height;
    const maximumDrops = width < 700 ? 46 : 84;
    const dropCount = Math.max(26, Math.min(maximumDrops, Math.round(area / 14500)));
    const fogCount = width < 700 ? 3 : 5;

    drops = Array.from({ length: dropCount }, () => new RainDrop());
    fogBanks = Array.from({ length: fogCount }, (_, index) => new FogBank(index));
  };

  const drawScene = (shouldUpdate) => {
    context.clearRect(0, 0, width, height);

    if (shouldUpdate) {
      fogBanks.forEach((fogBank) => fogBank.update());
      drops.forEach((drop) => drop.update());
    }

    fogBanks.forEach((fogBank) => fogBank.draw());
    drops.forEach((drop) => drop.draw());

    if (shouldUpdate) {
      renderedFrames += 1;
      canvas.dataset.frame = String(renderedFrames);
    }
  };

  const resizeCanvas = () => {
    const bounds = hero.getBoundingClientRect();
    width = Math.max(1, Math.round(bounds.width));
    height = Math.max(1, Math.round(bounds.height));
    deviceScale = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.round(width * deviceScale);
    canvas.height = Math.round(height * deviceScale);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
    createAtmosphere();
    drawScene(false);
  };

  const getAnimationState = () => {
    if (reduceMotionQuery.matches) return "paused-reduced-motion";
    if (!heroIsVisible) return "paused-offscreen";
    if (document.visibilityState !== "visible") return "paused-hidden";
    return "running";
  };

  const shouldAnimate = () => getAnimationState() === "running";

  const stopAnimation = () => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  };

  const animate = (time) => {
    if (!shouldAnimate()) {
      stopAnimation();
      canvas.dataset.animationState = getAnimationState();
      return;
    }

    animationFrame = requestAnimationFrame(animate);
    if (time - lastFrameTime < frameInterval) return;

    lastFrameTime = time;
    drawScene(true);
  };

  const syncAnimation = () => {
    stopAnimation();
    canvas.dataset.animationState = getAnimationState();

    if (shouldAnimate()) {
      animationFrame = requestAnimationFrame(animate);
    } else {
      drawScene(false);
    }
  };

  const observer = new IntersectionObserver((entries) => {
    heroIsVisible = entries[0]?.isIntersecting ?? true;
    syncAnimation();
  }, { threshold: 0.02 });

  const resizeObserver = new ResizeObserver(() => resizeCanvas());

  observer.observe(hero);
  resizeObserver.observe(hero);
  document.addEventListener("visibilitychange", syncAnimation);
  reduceMotionQuery.addEventListener("change", syncAnimation);

  resizeCanvas();
  syncAnimation();
})();
