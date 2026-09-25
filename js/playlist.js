'use strict';

/*
 * Плейлист передатчика: порядок треков, режим «по кругу» или «случайно».
 * В случайном режиме треки тянутся из перемешанного «мешка», поэтому ни один
 * не повторится, пока не сыграют все остальные.
 */
class Playlist {
  constructor() {
    this.items = [];     // { id, file, url, name }
    this.current = -1;   // индекс текущего трека
    this.cued = false;   // текущий трек выбран вручную и ещё не звучал
    this.shuffle = false;
    this.bag = [];       // id треков, которые ещё не звучали в этом случайном круге
    this.nextId = 1;
  }

  get size() {
    return this.items.length;
  }

  get currentItem() {
    return this.items[this.current] ?? null;
  }

  add(files) {
    for (const file of files) {
      this.items.push({
        id: this.nextId++,
        file,
        url: URL.createObjectURL(file),
        name: file.name.replace(/\.[^.]+$/, ''),
      });
    }
  }

  // Возвращает true, если убрали трек, который сейчас играет
  remove(id) {
    const i = this.items.findIndex((item) => item.id === id);
    if (i === -1) return false;
    URL.revokeObjectURL(this.items[i].url);
    this.items.splice(i, 1);
    this.bag = this.bag.filter((bagId) => bagId !== id);
    if (i < this.current) {
      this.current--;
      return false;
    }
    if (i === this.current) {
      this.current = i - 1; // следующим пойдёт трек, стоявший за удалённым
      this.cued = false;
      return true;
    }
    return false;
  }

  setShuffle(on) {
    this.shuffle = on;
    this.bag = [];
  }

  // Выбранный вручную трек сыграет следующим
  cue(id) {
    const i = this.items.findIndex((item) => item.id === id);
    if (i === -1) return null;
    this.current = i;
    this.cued = true;
    return this.items[i];
  }

  next() {
    const n = this.items.length;
    if (!n) {
      this.current = -1;
      return null;
    }
    if (this.cued) {
      this.cued = false;
      return this.currentItem;
    }
    if (!this.shuffle) {
      this.current = (this.current + 1) % n;
      return this.currentItem;
    }
    if (!this.bag.length) {
      this.bag = this.items.map((item) => item.id);
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
      // Новый круг не начинается с трека, который только что доиграл (берём с конца мешка)
      const last = this.bag.length - 1;
      if (last > 0 && this.bag[last] === this.currentItem?.id) {
        [this.bag[0], this.bag[last]] = [this.bag[last], this.bag[0]];
      }
    }
    const id = this.bag.pop();
    this.current = this.items.findIndex((item) => item.id === id);
    return this.currentItem;
  }
}
