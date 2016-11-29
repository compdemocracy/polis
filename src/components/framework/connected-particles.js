// Copyright (C) 2012-present, Polis Technology Inc. This program is free software: you can redistribute it and/or  modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

export const particles = (config) => {

  setTimeout(() => {
    var canvas = document.querySelector("canvas"),
        context = canvas.getContext("2d"),
        width = canvas.width,
        height = canvas.height,
        radius = config.radius,
        minDistance = 40,
        maxDistance = 60,
        minDistance2 = minDistance * minDistance,
        maxDistance2 = maxDistance * maxDistance;

    var tau = 2 * Math.PI,
        n = config.count,
        particles = new Array(n);

    for (var i = 0; i < n; ++i) {
      particles[i] = {
        x: Math.random() * width,
        y: Math.random() * height,
        vx: 0,
        vy: 0
      };
    }

    timer.timer(function(elapsed) {
      context.save();
      context.clearRect(0, 0, width, height);

      for (var i = 0; i < n; ++i) {
        var p = particles[i];
        p.x += p.vx; if (p.x < -maxDistance) p.x += width + maxDistance * 2; else if (p.x > width + maxDistance) p.x -= width + maxDistance * 2;
        p.y += p.vy; if (p.y < -maxDistance) p.y += height + maxDistance * 2; else if (p.y > height + maxDistance) p.y -= height + maxDistance * 2;
        p.vx += 0.2 * (Math.random() - .5) - 0.01 * p.vx;
        p.vy += 0.2 * (Math.random() - .5) - 0.01 * p.vy;
        context.beginPath();
        context.arc(p.x, p.y, radius, 0, tau);
        context.fillStyle = config.color;
        context.fill();
      }

      for (var i = 0; i < n; ++i) {
        for (var j = i + 1; j < n; ++j) {
          var pi = particles[i],
              pj = particles[j],
              dx = pi.x - pj.x,
              dy = pi.y - pj.y,
              d2 = dx * dx + dy * dy;
          if (d2 < maxDistance2) {
            context.globalAlpha = d2 > minDistance2 ? (maxDistance2 - d2) / (maxDistance2 - minDistance2) : 1;
            context.beginPath();
            context.moveTo(pi.x, pi.y);
            context.lineTo(pj.x, pj.y);
            context.lineWidth=config.lineWidth;
            context.strokeStyle = config.color;
            context.stroke();
          }
        }
      }

      context.restore();
    });

  }, 500)
}
